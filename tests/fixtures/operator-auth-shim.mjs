export async function isOperatorRequest() {
  return true;
}

export function operatorNoStoreHeaders() {
  return { "Cache-Control": "no-store" };
}
