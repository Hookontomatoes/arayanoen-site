// LINEの接続確認用（GET/POSTともに200 OKを返す）
export async function onRequestPost() {
  return new Response('OK', { status: 200 });
}
export async function onRequest() {
  return new Response('OK', { status: 200 });
}
