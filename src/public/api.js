// fetch wrapper: adds X-Sky-Eye on non-GET (spec §4.2), propagates errors/409s.
async function handle(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw { status: res.status, ...body };
  return body;
}

export const get = (path) => fetch(path).then(handle);

export const mut = (method, path, body) =>
  fetch(path, {
    method,
    headers: { "content-type": "application/json", "x-sky-eye": "1" },
    body: JSON.stringify(body ?? {}),
  }).then(handle);
