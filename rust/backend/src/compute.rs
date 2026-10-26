use serde_json::{Value, json};
use std::{env, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{Mutex, OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch},
    time::{Instant, timeout_at},
};

const REQUEST_LIMIT: usize = 65_536;
const RESPONSE_LIMIT: usize = 1024 * 1024;

#[derive(Clone, Debug)]
pub struct Failure {
    pub reason: &'static str,
    pub message: String,
}
impl Failure {
    fn new(reason: &'static str, message: impl Into<String>) -> Self {
        Self {
            reason,
            message: message.into(),
        }
    }
}
#[derive(Clone, Debug)]
pub struct Computed {
    pub value: Value,
    pub queue_ms: u64,
    pub worker_ms: u64,
}
// A valid frame is not sufficient: successful results must belong to the
// requested player/cycle before they can become a durable public answer.
pub fn valid_lookup(value: &Value, input: &Value) -> bool {
    let Some(available) = value.get("available").and_then(Value::as_bool) else {
        return false;
    };
    let Some(result) = value.get("result") else {
        return false;
    };
    if result.is_null() {
        return true;
    }
    if !available || !result.is_object() {
        return false;
    }
    let Some(aid) = input.get("aid").and_then(Value::as_i64) else {
        return false;
    };
    let Some(cycle) = input.get("cycleId").and_then(Value::as_str) else {
        return false;
    };
    result.get("mode").and_then(Value::as_str) == Some("seasonal")
        && result.get("aid").and_then(Value::as_i64) == Some(aid)
        && result.get("cycleId").and_then(Value::as_str) == Some(cycle)
        && result.get("identity").is_some_and(|identity| {
            identity.get("mode").and_then(Value::as_str) == Some("seasonal")
                && identity.get("aid").and_then(Value::as_i64) == Some(aid)
                && identity.get("cycleId").and_then(Value::as_str) == Some(cycle)
        })
}
#[derive(Clone, Copy)]
pub enum Kind {
    Seasonal,
    ArenaPopulation,
    PersistentAverage,
    PersistentMetrics,
    AchievementBaseline,
    AchievementMetadata,
}
impl Kind {
    pub fn from_job(job: &Value) -> Option<Self> {
        match job.get("kind")?.as_str()? {
            "seasonal" => Some(Self::Seasonal),
            "arena_population" => Some(Self::ArenaPopulation),
            "persistent_average" => Some(Self::PersistentAverage),
            "persistent_metrics" => Some(Self::PersistentMetrics),
            "achievement_baseline" => Some(Self::AchievementBaseline),
            "achievement_metadata" => Some(Self::AchievementMetadata),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Seasonal => "seasonal",
            Self::ArenaPopulation => "arena_population",
            Self::PersistentAverage => "persistent_average",
            Self::PersistentMetrics => "persistent_metrics",
            Self::AchievementBaseline => "achievement_baseline",
            Self::AchievementMetadata => "achievement_metadata",
        }
    }
    pub fn ttl_ms(self) -> f64 {
        match self {
            Self::Seasonal | Self::AchievementBaseline => 300000.0,
            Self::AchievementMetadata => 21600000.0,
            Self::ArenaPopulation | Self::PersistentAverage | Self::PersistentMetrics => 900000.0,
        }
    }
    fn deadline_ms(self) -> u64 {
        match self {
            Self::PersistentAverage => 30_000,
            _ => 15_000,
        }
    }
    pub fn valid(self, value: &Value, job: &Value) -> bool {
        let Some(input) = job.get("args").and_then(|args| args.get(0)) else {
            return false;
        };
        match self {
            Self::Seasonal => valid_lookup(value, input),
            Self::ArenaPopulation => value.is_null() || crate::arena::valid_result(value, input),
            Self::PersistentAverage => crate::persistent::valid_average(value, job),
            Self::PersistentMetrics => crate::persistent::valid_metrics(value, job),
            Self::AchievementBaseline => crate::achievements::valid_baseline(value, job),
            Self::AchievementMetadata => crate::reference::valid_metadata(value, job),
        }
    }
    pub fn accepted(self, value: &Value) -> bool {
        match self {
            Self::Seasonal => {
                value.get("available").and_then(Value::as_bool) == Some(true)
                    && value.get("result").is_some_and(|value| !value.is_null())
            }
            Self::ArenaPopulation | Self::PersistentMetrics => !value.is_null(),
            Self::AchievementBaseline => {
                value.get("storage").and_then(Value::as_str) == Some("sqlite")
            }
            Self::AchievementMetadata => value.as_array().is_some_and(|values| !values.is_empty()),
            Self::PersistentAverage => {
                value.get("storage").and_then(Value::as_str) == Some("sqlite")
            }
        }
    }
}
struct Job {
    args: Value,
    queued: Instant,
    deadline: Instant,
    reply: oneshot::Sender<Result<Computed, Failure>>,
    _permit: OwnedSemaphorePermit,
}
struct Session {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
impl Session {
    fn launch(executable: &str, args: &[String]) -> Result<Self, Failure> {
        #[cfg(unix)]
        let mut command = {
            let mut command = Command::new("nice");
            command.args(["-n", "19", executable]);
            command
        };
        #[cfg(not(unix))]
        let mut command = Command::new(executable);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000 | 0x00000040);
        let mut child = command
            .spawn()
            .map_err(|error| Failure::new("worker_spawn", error.to_string()))?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| Failure::new("worker_io", "Worker stdin unavailable"))?;
        let output = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| Failure::new("worker_io", "Worker stdout unavailable"))?,
        );
        Ok(Self {
            child,
            input,
            output,
        })
    }
    async fn exchange(&mut self, id: u64, args: &Value) -> Result<Value, Failure> {
        let mut frame = serde_json::to_vec(&json!({"version":1,"id":id,"args":[args]}))
            .map_err(|error| Failure::new("protocol", error.to_string()))?;
        frame.push(b'\n');
        if frame.len() > REQUEST_LIMIT {
            return Err(Failure::new("protocol", "Worker request exceeds64KiB"));
        }
        self.input
            .write_all(&frame)
            .await
            .map_err(|error| Failure::new("worker_io", error.to_string()))?;
        self.input
            .flush()
            .await
            .map_err(|error| Failure::new("worker_io", error.to_string()))?;
        let frame = read_frame(&mut self.output).await?;
        let reply: Value = serde_json::from_slice(&frame)
            .map_err(|_| Failure::new("protocol", "Invalid worker JSON"))?;
        if reply.get("id").and_then(Value::as_u64) != Some(id) {
            return Err(Failure::new("protocol", "Worker reply identity mismatch"));
        }
        match (reply.get("result"), reply.get("error")) {
            (Some(value), None) => {
                if !Kind::from_job(args).is_some_and(|kind| kind.valid(value, args)) {
                    return Err(Failure::new(
                        "protocol",
                        "Invalid worker result identity or shape",
                    ));
                }
                Ok(value.clone())
            }
            (None, Some(Value::String(error))) => Err(Failure::new(
                "calculation_error",
                error.chars().take(512).collect::<String>(),
            )),
            _ => Err(Failure::new("protocol", "Invalid worker reply envelope")),
        }
    }
    async fn stop(mut self) {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
    }
}
async fn read_frame(reader: &mut (impl AsyncBufRead + Unpin)) -> Result<Vec<u8>, Failure> {
    let mut frame = Vec::with_capacity(4096);
    loop {
        let bytes = reader
            .fill_buf()
            .await
            .map_err(|error| Failure::new("worker_io", error.to_string()))?;
        if bytes.is_empty() {
            return Err(Failure::new("worker_exit", "Worker exited before reply"));
        }
        let end = bytes.iter().position(|ch| *ch == b'\n');
        let count = end.map_or(bytes.len(), |i| i + 1);
        if frame.len() + count > RESPONSE_LIMIT {
            return Err(Failure::new("protocol", "Worker response exceeds1MiB"));
        }
        frame.extend_from_slice(&bytes[..count]);
        reader.consume(count);
        if end.is_some() {
            return Ok(frame);
        }
    }
}

#[derive(Clone)]
pub struct Worker {
    sender: mpsc::Sender<Job>,
    slots: Arc<Semaphore>,
    timeout: Option<Duration>,
    shutdown: watch::Sender<bool>,
    task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
}
impl Worker {
    pub fn start() -> Result<Self, String> {
        let executable = env::var("RUST_COHORT_BIN").unwrap_or_else(|_| {
            format!(
                "rust/cohort-worker/target/release/tarkov-cohort-worker{}",
                env::consts::EXE_SUFFIX
            )
        });
        let args: Vec<String> = match env::var("RUST_COHORT_ARGS") {
            Ok(raw) => serde_json::from_str(&raw)
                .map_err(|_| "RUST_COHORT_ARGS must be a JSON string array")?,
            Err(_) => Vec::new(),
        };
        let timeout = env::var("RUST_API_COMPUTE_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|v| *v > 0)
            .map(|v| Duration::from_millis(v.min(30_000)));
        let (sender, mut receiver) = mpsc::channel::<Job>(8);
        let (shutdown, mut stopped) = watch::channel(false);
        let task = tokio::spawn(async move {
            let mut session: Option<Session> = None;
            let mut next_id = 0;
            loop {
                let job = tokio::select! {biased;_ = stopped.changed()=>break,job=receiver.recv()=>match job{Some(job)=>job,None=>break}};
                let dispatched = Instant::now();
                let queue_ms = (dispatched - job.queued).as_millis() as u64;
                let result = if dispatched >= job.deadline {
                    Err(Failure::new(
                        "deadline",
                        "Cohort request timed out in queue",
                    ))
                } else {
                    next_id += 1;
                    let exchange = async {
                        if session.is_none() {
                            session = Some(Session::launch(&executable, &args)?)
                        }
                        session.as_mut().unwrap().exchange(next_id, &job.args).await
                    };
                    tokio::select! {biased;
                        _=stopped.changed()=>Err(Failure::new("stopped","Cohort worker stopped")),
                        result=timeout_at(job.deadline,exchange)=>match result{Ok(result)=>result,Err(_)=>Err(Failure::new("deadline","Cohort worker timed out"))},
                    }
                };
                let worker_ms = dispatched.elapsed().as_millis() as u64;
                if result
                    .as_ref()
                    .is_err_and(|error| error.reason != "calculation_error")
                    && let Some(child) = session.take()
                {
                    child.stop().await;
                }
                crate::log_json(
                    &json!({"event":"cohort_job_v1","at":crate::now_ms(),"kind":Kind::from_job(&job.args).map(Kind::name),"backend":"rust","outcome":result.as_ref().map_or_else(|e|e.reason,|_|"success"),"elapsed_ms":job.queued.elapsed().as_millis()as u64,"queue_ms":queue_ms,"worker_ms":worker_ms}),
                );
                let _ = job.reply.send(result.map(|value| Computed {
                    value,
                    queue_ms,
                    worker_ms,
                }));
                if *stopped.borrow() {
                    break;
                }
            }
            if let Some(child) = session {
                child.stop().await;
            }
            while let Ok(job) = receiver.try_recv() {
                let _ = job
                    .reply
                    .send(Err(Failure::new("stopped", "Cohort worker stopped")));
            }
        });
        Ok(Self {
            sender,
            slots: Arc::new(Semaphore::new(8)),
            timeout,
            shutdown,
            task: Arc::new(Mutex::new(Some(task))),
        })
    }
    pub async fn compute(&self, args: Value) -> Result<Computed, Failure> {
        if matches!(
            Kind::from_job(&args),
            Some(Kind::AchievementBaseline | Kind::AchievementMetadata)
        ) {
            return Err(Failure::new(
                "protocol",
                "Asynchronous data jobs require a cache factory",
            ));
        }
        let permit = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Failure::new("queue_full", "Cohort queue is full"))?;
        let queued = Instant::now();
        let default =
            Duration::from_millis(Kind::from_job(&args).map_or(15_000, Kind::deadline_ms));
        let budget = self.timeout.map_or(default, |limit| default.min(limit));
        let deadline = queued + budget;
        let (reply, answer) = oneshot::channel();
        self.sender
            .try_send(Job {
                args,
                queued,
                deadline,
                reply,
                _permit: permit,
            })
            .map_err(|_| Failure::new("queue_full", "Cohort queue unavailable"))?;
        timeout_at(deadline, answer)
            .await
            .map_err(|_| Failure::new("deadline", "Cohort request timed out"))?
            .map_err(|_| Failure::new("worker_exit", "Cohort worker unavailable"))?
    }
    pub fn shutdown(&self) {
        let _ = self.shutdown.send(true);
    }
    pub async fn stop(&self) {
        self.shutdown();
        if let Some(task) = self.task.lock().await.take() {
            let _ = task.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn reply_frames_are_bounded_and_preserve_following_frame() {
        let mut reader = BufReader::new(b"{\"id\":1}\nsecond\n".as_slice());
        assert_eq!(read_frame(&mut reader).await.unwrap(), b"{\"id\":1}\n");
        assert_eq!(read_frame(&mut reader).await.unwrap(), b"second\n");
    }
    #[tokio::test]
    async fn truncated_and_oversized_replies_fail_closed() {
        let mut reader = BufReader::new(b"unfinished".as_slice());
        assert_eq!(
            read_frame(&mut reader).await.unwrap_err().reason,
            "worker_exit"
        );
        let data = vec![b'x'; RESPONSE_LIMIT + 1];
        let mut reader = BufReader::new(data.as_slice());
        assert_eq!(
            read_frame(&mut reader).await.unwrap_err().reason,
            "protocol"
        );
    }
    #[test]
    fn malformed_or_cross_identity_lookup_never_becomes_a_public_answer() {
        let input = json!({"aid":1,"cycleId":"s1"});
        let answer = json!({"available":true,"result":{"aid":1,"mode":"seasonal","cycleId":"s1","identity":{"aid":1,"mode":"seasonal","cycleId":"s1"}}});
        assert!(valid_lookup(&answer, &input));
        for result in [json!(false), json!("unexpected"), json!([])] {
            assert!(!valid_lookup(
                &json!({"available":true,"result":result}),
                &input
            ));
        }
        assert!(!valid_lookup(
            &json!({"available":"true","result":null}),
            &input
        ));
        for key in ["aid", "cycleId", "mode"] {
            let mut broken = answer.clone();
            broken["result"][key] = json!("wrong");
            assert!(!valid_lookup(&broken, &input));
            let mut broken = answer.clone();
            broken["result"]["identity"][key] = json!("wrong");
            assert!(!valid_lookup(&broken, &input));
        }
        assert!(valid_lookup(
            &json!({"available":true,"result":null}),
            &input
        ));
        assert!(valid_lookup(
            &json!({"available":false,"result":null}),
            &input
        ));
    }
}
