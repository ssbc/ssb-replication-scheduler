// SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros
//
// SPDX-License-Identifier: Unlicense

const tape = require('tape')
const ssbKeys = require('ssb-keys')
const path = require('path')
const os = require('os')
const rimraf = require('rimraf')
const caps = require('ssb-caps')
const SecretStack = require('secret-stack')
const pify = require('promisify-4loc')
const sleep = require('util').promisify(setTimeout)

const createSsbServer = SecretStack({ caps })
  .use(require('ssb-db2'))
  .use(require('ssb-db2/compat/ebt'))
  .use(require('ssb-ebt'))
  .use(require('ssb-friends'))
  .use(require('../..'))

const CONNECTION_TIMEOUT = 500 // ms
const REPLICATION_TIMEOUT = 6 * CONNECTION_TIMEOUT

tape('dont request during db2 indexing', async (t) => {
  rimraf.sync(path.join(os.tmpdir(), 'server-alice'))

  const alice = createSsbServer({
    path: path.join(os.tmpdir(), 'server-alice'),
    keys: ssbKeys.generate(null, 'alice'),
    timeout: CONNECTION_TIMEOUT,
    replicationScheduler: {
      autostart: false,
      debouncePeriod: 0,
    },
  })
  const bobId = ssbKeys.generate(null, 'bob').id
  const carolId = ssbKeys.generate(null, 'carol').id
  t.pass('started the 3 peers')

  await sleep(500)

  await Promise.all([
    pify(alice.db.publish)({ type: 'post', text: 'hello' }),

    pify(alice.db.publish)({
      type: 'contact',
      contact: bobId,
      following: true,
    }),
    pify(alice.db.publish)({
      type: 'contact',
      contact: carolId,
      following: true,
    }),
  ])
  await pify(alice.db.publish)({
    type: 'contact',
    contact: bobId,
    blocking: true,
  })
  t.pass('published all the messages')


  await sleep(REPLICATION_TIMEOUT)

  const originalEBTRequest = alice.ebt.request
  alice.ebt.request = function request(id, val) {
    if (id === bobId) {
      if (val === true) {
        t.fail('requested bob, who is blocked')
      }
    }
    originalEBTRequest.call(alice.ebt, id, val)
  }

  alice.replicationScheduler.start()
  t.pass('started replication scheduler')

  await pify(alice.db.reset)()
  t.pass('reset indexes')

  await sleep(REPLICATION_TIMEOUT)

  await pify(alice.close)(true)

  t.end()
})
