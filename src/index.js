/// <reference types="@fastly/js-compute" />

import { KVStore } from "fastly:kv-store";
import { SecretStore } from "fastly:secret-store";
import { createFanoutHandoff } from "fastly:fanout";
import { env } from 'fastly:env';
import { Hono } from 'hono'
import { logger } from 'hono/logger'

import { includeBytes } from "fastly:experimental";

const page = includeBytes('./src/index.html')

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

const app = new Hono()
app.onError((error, c) => {
  console.error('Internal App Error:', error, error.stack, error.message);
  return c.text('Internal Server Error', 500)
});
app.use('*', logger());
app.use('*', async (c, next) => {
  const FASTLY_SERVICE_VERSION = env('FASTLY_SERVICE_VERSION');
  console.log('FASTLY_SERVICE_VERSION', FASTLY_SERVICE_VERSION);
  await next();
  c.header('FASTLY_SERVICE_VERSION', FASTLY_SERVICE_VERSION);
  c.header("x-compress-hint", "on");
});

app.get('/', () => {
  return new Response(page, {
    headers: {
      "content-type": "text/html;charset=utf-8"
    }
  })
})

async function publish(channel, event, data) {
  const store = new SecretStore('todo');
  const key = await store.get('fastly-token').then(a => a.plaintext())
  const content = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  return fetch(`https://api.fastly.com/service/${env('FASTLY_SERVICE_ID')}/publish/`, {
    backend: 'fastly',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      "Fastly-Key": key
    },
    body: JSON.stringify({ "items": [{ channel, "formats": { "http-stream": { content } } }] })
  })
}

app.get('/init', async (c) => {
  const channel = c.req.query('channel')
  const me = c.req.query('me')
  const store = new KVStore('lists');
  const list = await store.get(channel)?.then(a => a?.json() || []);
  list.forEach((a, index) => {
    if (!Object.hasOwn(a, 'position')) {
      a.position = index;
    }
  })
  return await publish(channel, 'init', { list, me })
})
app.get('/delete', async (c) => {
  const channel = c.req.query('channel')
  const id = c.req.query('id')
  const store = new KVStore('lists');
  const list = await store.get(channel)?.then(a => a?.json() || []);
  list.forEach((item, index) => {
    if (item.id == id) {
      list.splice(index, 1);
    }
    item.position = index;
  })
  c.executionCtx.waitUntil(store.put(channel, JSON.stringify(list)))
  return await publish(channel, 'delete', { id })
})
app.get('/insert', async (c) => {
  const channel = c.req.query('channel')
  const id = c.req.query('id')
  const contents = c.req.query('contents')
  const store = new KVStore('lists');
  const list = await store.get(channel)?.then(a => a?.json() || []);
  list.push({ id, contents, position: list.length })
  c.executionCtx.waitUntil(store.put(channel, JSON.stringify(list)))
  return await publish(channel, 'insert', { id, contents })
})
app.get('/toggle', async (c) => {
  const channel = c.req.query('channel')
  const id = c.req.query('id')
  const checked = JSON.parse(c.req.query('checked'))
  const store = new KVStore('lists');
  const list = await store.get(channel)?.then(a => a?.json() || []);
  list.find(item => item.id == id).checked = checked;
  c.executionCtx.waitUntil(store.put(channel, JSON.stringify(list)))
  return await publish(channel, 'toggle', { id, checked })
})
app.get('/update-contents', async c => {
  const channel = c.req.query('channel')
  const id = c.req.query('id')
  const contents = c.req.query('contents')
  const store = new KVStore('lists');
  const list = await store.get(channel)?.then(a => a?.json() || []);
  list.find(item => item.id == id).contents = contents;
  c.executionCtx.waitUntil(store.put(channel, JSON.stringify(list)))
  return await publish(channel, 'update-contents', { id, contents })
});
app.get('/toggle-all', async (c) => {
  const channel = c.req.query('channel')
  const checked = JSON.parse(c.req.query('checked'))
  const store = new KVStore('lists');
  const list = await store.get(channel)?.then(a => a?.json() || []);
  list.forEach(item => item.checked = checked);
  c.executionCtx.waitUntil(store.put(channel, JSON.stringify(list)))
  return await publish(channel, 'toggle-all', { checked })
})
app.get('/clear-completed', async (c) => {
  const channel = c.req.query('channel')
  const store = new KVStore('lists');
  let list = await store.get(channel)?.then(a => a?.json() || []);
  list = list.filter(item => !item.checked)
  list.forEach((item, index) => {
    item.position = index;
  })
  c.executionCtx.waitUntil(store.put(channel, JSON.stringify(list)))
  return await publish(channel, 'clear-completed', {})
})
app.get('/update-positions', async (c) => {
  const channel = c.req.query('channel')
  const positions = JSON.parse(c.req.query('positions'))
  const store = new KVStore('lists');
  const list = await store.get(channel)?.then(a => a?.json() || []);
  list.forEach((item) => {
    let index = positions.findIndex(a => a == item.id)
    item.position = index != -1 ? index : Infinity;
  });
  list.sort((a, b) => {
    return a.position - b.position
  })
  list.forEach((item, index) => {
    if (item.position == Infinity) {
      item.position = index;
    }
  })
  c.executionCtx.waitUntil(store.put(channel, JSON.stringify(list)))
  return await publish(channel, 'updated-positions', { list })
})
app.get('/stream/sse', c => {
  const channel = c.req.query('channel')
  // Request is from Fanout
  if (c.req.header('Grip-Sig')) {
    // Needed so that Firefox emits the 'open' event for the EventSource
    c.executionCtx.waitUntil(sleep(10).then(() => publish(channel, 'ping', {})))
    return grip_response("text/event-stream", "stream", channel)
  } else {
    // Not from Fanout, hand it off to Fanout to manage
    return createFanoutHandoff(c.executionCtx.request, 'self');
  }
})

function grip_response(contentType, gripHold, channel) {
  return new Response(null, {
    headers: {
      "Content-Type": contentType,
      "Grip-Hold": gripHold,
      "Grip-Channel": channel,
    }
  })
}

app.fire()
