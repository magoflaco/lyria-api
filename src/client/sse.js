// Minimal Server-Sent Events parser over a fetch() Response body stream.
// Yields { id, event, data } objects. `data` is left as a raw string; callers
// JSON.parse it as needed.

export async function* parseSSE(response) {
  if (!response.body) throw new Error('Response has no readable body for SSE');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep;
      // Events are separated by a blank line (\n\n). Handle \r\n too.
      while ((sep = indexOfDoubleNewline(buffer)) !== -1) {
        const rawEvent = buffer.slice(0, sep.index);
        buffer = buffer.slice(sep.index + sep.length);
        const evt = parseEventBlock(rawEvent);
        if (evt) yield evt;
      }
    }
    // Flush any trailing event without a final blank line.
    const evt = parseEventBlock(buffer);
    if (evt) yield evt;
  } finally {
    reader.releaseLock?.();
  }
}

function indexOfDoubleNewline(s) {
  const a = s.indexOf('\n\n');
  const b = s.indexOf('\r\n\r\n');
  if (a === -1 && b === -1) return -1;
  if (a === -1) return { index: b, length: 4 };
  if (b === -1) return { index: a, length: 2 };
  return a < b ? { index: a, length: 2 } : { index: b, length: 4 };
}

function parseEventBlock(block) {
  const lines = block.split(/\r?\n/);
  let id = null;
  let event = 'message';
  const dataLines = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue; // comment / keep-alive ping
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    let val = idx === -1 ? '' : line.slice(idx + 1);
    if (val.startsWith(' ')) val = val.slice(1);
    if (field === 'id') id = val;
    else if (field === 'event') event = val;
    else if (field === 'data') dataLines.push(val);
  }
  if (dataLines.length === 0 && id === null) return null;
  return { id, event, data: dataLines.join('\n') };
}
