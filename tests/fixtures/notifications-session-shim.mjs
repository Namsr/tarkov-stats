export let user = { sub: "alice" };
export function setUser(value) { user = value; }
export async function getSession() { return user; }
