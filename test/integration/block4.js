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
  temp: 'test-block4-alice',
  timeout: CONNECTION_TIMEOUT,
  keys: u.keysFor('alice'),
  replicationScheduler: {
    debouncePeriod: 0,
  },
  friends: {
    hops: 4,
  },
})

const bob = createSsbServer({
  temp: 'test-block4-bob',
  timeout: CONNECTION_TIMEOUT,
  keys: u.keysFor('bob'),
  replicationScheduler: {
    debouncePeriod: 0,
  },
  friends: {
    hops: 4,
  },
})

const carol = createSsbServer({
  temp: 'test-block4-carol',
  timeout: CONNECTION_TIMEOUT,
  keys: u.keysFor('carol'),
  replicationScheduler: {
    debouncePeriod: 0,
  },
  friends: {
    hops: 4,
  },
})

tape('middle friend does not forward data to the blocked one', async (t) => {
  t.plan(6)

  // Alice follows Carols, but Carol blocks Alice
  await Promise.all([
    pify(alice.publish)(u.follow(carol.id)),
    pify(carol.publish)(u.block(alice.id)),
  ])

  // Bob is mutual friends with all others
  await Promise.all([
    pify(bob.publish)(u.follow(alice.id)),
    pify(alice.publish)(u.follow(bob.id)),
    pify(bob.publish)(u.follow(carol.id)),
    pify(carol.publish)(u.follow(bob.id)),
  ])

  await Promise.all([
    pify(bob.connect)(alice.getAddress()),
    pify(bob.connect)(carol.getAddress()),
  ])

  await sleep(REPLICATION_TIMEOUT)

  // Bob has all the data from everyone
  const clockBob = await pify(bob.getVectorClock)()
  t.equals(clockBob[alice.id], 2, 'bob has 2 messages from alice')
  t.equals(clockBob[bob.id], 2, 'bob has 2 messages from bob')
  t.equals(clockBob[carol.id], 2, 'bob has 2 messages from carol')

  // Alice has data from Bob but NOT carol
  const clockAlice = await pify(alice.getVectorClock)()
  t.equals(clockAlice[alice.id], 2, 'alice has 2 messages from alice')
  t.equals(clockAlice[bob.id], 2, 'alice has 2 messages from bob')
  t.equals(clockAlice[carol.id], undefined, 'alice has no messages from carol')

  await Promise.all([
    pify(alice.close)(true),
    pify(bob.close)(true),
    pify(carol.close)(true),
  ])

  t.end()
})
