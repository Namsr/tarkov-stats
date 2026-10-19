# Axis screenshot recognition model

The browser uses the official `en_PP-OCRv5_mobile_rec` ONNX recognition model from PaddleOCR. Screenshot pixels are processed locally in a dedicated worker; the application does not send them to an inference service. The existing authorized screenshot-save endpoint remains separate from recognition.

- [Official model card and Apache-2.0 license](https://huggingface.co/PaddlePaddle/en_PP-OCRv5_mobile_rec)
- [Official ONNX archive](https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/en_PP-OCRv5_mobile_rec_onnx_infer.tar)
- [Official browser preprocessing and model loader](https://github.com/PaddlePaddle/PaddleOCR/tree/main/paddleocr-js/packages/core/src)

`model.onnx` and `dictionary.json` are source assets. The dictionary excludes the CTC blank and includes the trailing space required by the model. `provenance.json` records the source and checksums. The model license is included in `LICENSE`; `ONNXRUNTIME-LICENSE` is vendored from the official ONNX Runtime v1.30.0 source because its npm package omits that file.

`npm run dev` and `npm run build` copy these files and the CPU WASM runtime to the ignored `public/ocr/paddle-v1/` directory. Builds require no Python environment or model download. Production serves all inference assets from the same origin.

The shared preprocessing uses BGR channels, aspect-preserving bilinear resize to height 48, normalized zero padding, and greedy CTC decoding. Nickname regions are first cropped to their visible text. Identity assignment accepts only unique exact roster aliases and abstains on ambiguity.

For a labeled local corpus, run:

```sh
node --experimental-strip-types scripts/benchmark-axis-ocr.mjs /path/to/manifest.json /path/to/report.json
```

The manifest contains `split` and `matches`. Each match supplies its local `image` path, `matchNumber`, `score: {left,right}`, `leftTeamIndex`, the ten `participants`, and ten labeled `rows` with `id`, `discordId`, `kills`, `deaths`, and `assists`. See the types in `lib/axis-ocr.ts` for participant and row fields.

Development samples used to select preprocessing do not establish accuracy on new screenshots. Keep an independent validation set, count unread fields as misses, and report identity errors separately from numeric errors. Moderators must review the preview before filling and saving results.
