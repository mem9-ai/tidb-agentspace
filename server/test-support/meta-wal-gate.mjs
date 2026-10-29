import http from 'node:http';

export async function walGate(endpoint) {
  let paused = false;
  const pending = [];
  let ownerReadsToPause = 0;
  let ownerReadCount = 0;
  const ownerReads = [];
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
    const ownerRead = incoming.method === 'GET' && incoming.url.includes('/control/owner.json');
    if (ownerRead) ownerReadCount++;
    if (ownerReadsToPause && ownerRead) {
      ownerReadsToPause--;
      ownerReads.push(forward);
    } else if (paused && incoming.method === 'PUT' && incoming.url.includes('/slatedb/wal/'))
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
    pauseNextOwnerRead() {
      ownerReadsToPause++;
    },
    get waitingOwnerReads() {
      return ownerReads.length;
    },
    get ownerReadCount() {
      return ownerReadCount;
    },
    resumeOwnerReads() {
      ownerReadsToPause = 0;
      for (const forward of ownerReads.splice(0)) forward();
    },
    resume() {
      paused = false;
      for (const forward of pending.splice(0)) forward();
    },
    async close() {
      for (const forward of pending.splice(0)) forward();
      for (const forward of ownerReads.splice(0)) forward();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
