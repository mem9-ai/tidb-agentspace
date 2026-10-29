import http from 'node:http';

export async function walGate(endpoint) {
  let paused = false;
  const pending = [];
  const server = http.createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const forward = () => {
      const request = http.request(
        new URL(incoming.url, endpoint),
        { method: incoming.method, headers: incoming.headers },
        (response) => {
          outgoing.writeHead(response.statusCode, response.headers);
          response.pipe(outgoing);
        },
      );
      request.on('error', () => {
        outgoing.writeHead(503);
        outgoing.end();
      });
      request.end(Buffer.concat(chunks));
    };
    if (paused && incoming.method === 'PUT' && incoming.url.includes('/slatedb/wal/'))
      pending.push(forward);
    else forward();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    pause() {
      paused = true;
    },
    get waiting() {
      return pending.length;
    },
    resume() {
      paused = false;
      for (const forward of pending.splice(0)) forward();
    },
    async close() {
      for (const forward of pending.splice(0)) forward();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
