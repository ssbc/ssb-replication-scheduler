// SPDX-FileCopyrightText: 2021 Andre 'Staltz' Medeiros
//
// SPDX-License-Identifier: Unlicense

const tape = require('tape')
const crypto = require('crypto')
const pify = require('promisify-4loc')
const sleep = require('util').promisify(setTimeout)
const SecretStack = require('secret-stack')
const u = require('../misc/util')

// alice, bob, and carol all follow each other,
// but then bob offends alice, and she blocks him.
// this means that:
//
// 1. when bob tries to connect to alice, she refuses.
// 2. alice never tries to connect to bob. (removed from peers)
// 3. carol will not give bob any, she will not give him any data from alice.

const createSsbServer = SecretStack({
  caps: { shs: crypto.randomBytes(32).toString('base64') },
})
  .use(require('ssb-db'))
  .use(require('ssb-ebt'))
  .use(require('ssb-friends'))
  .use(require('../..'))

const CONNECTION_TIMEOUT = 500 // ms
const REPLICATION_TIMEOUT = 2 * CONNECTION_TIMEOUT

const alice = createSsbServer({
  temp: 'test-block3-alice',
  timeout: CONNECTION_TIMEOUT,
  keys: u.keysFor('alice'),
  replicationScheduler: {
    debouncePeriod: 0,
  },
})

const bob = createSsbServer({
  temp: 'test-block3-bob',
  timeout: CONNECTION_TIMEOUT,
  keys: u.keysFor('bob'),
  replicationScheduler: {
    debouncePeriod: 0,
  },
})

const carol = createSsbServer({
  temp: 'test-block3-carol',
  timeout: CONNECTION_TIMEOUT,
  keys: u.keysFor('carol'),
  replicationScheduler: {
    debouncePeriod: 0,
  },
})

tape('alice blocks bob and both are connected to carla', async (t) => {
  t.plan(3)

  // in the beginning alice and bob follow each other
  await Promise.all([
    pify(alice.publish)(u.follow(bob.id)),
    pify(bob.publish)(u.follow(alice.id)),
    pify(carol.publish)(u.follow(alice.id)),
  ])

  const [bc, ca] = await Promise.all([
    pify(bob.connect)(carol.getAddress()),
    pify(carol.connect)(alice.getAddress()),
  ])

  const msgAtBob = await u.readOnceFromDB(bob)

  // should be the alice's follow(bob) message.
  t.equal(msgAtBob.value.author, alice.id)
  t.equal(msgAtBob.value.content.contact, bob.id)

  const clockBob = await pify(bob.getVectorClock)()

  // FIXME: this disconnection followed by a re-connection is a hack
  // to bypass a race condition in ssb-ebt where it doesn't wait for
  // ssb-friends to compute changes to the social graph,
  await pify(bc.close)(true)

  await pify(alice.publish)(u.block(bob.id))

  await pify(bob.connect)(carol.getAddress())

  await sleep(REPLICATION_TIMEOUT)

  const clockBob2 = await pify(bob.getVectorClock)()
  t.equals(
    clockBob2[alice.id],
    clockBob[alice.id],
    'bob does not receive the message where alice blocked him'
  )

  await Promise.all([
    pify(alice.close)(true),
    pify(bob.close)(true),
    pify(carol.close)(true),
  ])

  t.end()
})
