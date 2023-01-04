// SPDX-FileCopyrightText: 2022 Jacob Karlsson
//
// SPDX-License-Identifier: Unlicense

const test = require('tape')
const rimraf = require('rimraf')
const SecretStack = require('secret-stack')
const caps = require('ssb-caps')
const ssbKeys = require('ssb-keys')
const p = require('util').promisify
const { where, author, count, toPromise } = require('ssb-db2/operators')
const u = require('../misc/util')

const sleep = p(setTimeout)
const REPLICATION_TIMEOUT = 4e3

const Server = (name, opts = {}) => {
  const path = `/tmp/ssb-replication-tests-${name}`
  rimraf.sync(path)

  const sbot = SecretStack({ caps })
    .use(require('ssb-db2/core'))
    .use(require('ssb-classic'))
    .use(require('ssb-box'))
    .use(require('ssb-box2'))
    .use(require('ssb-db2/compat/publish'))
    .use(require('ssb-db2/compat/post'))
    .use(require('ssb-db2/compat/ebt'))
    .use(require('ssb-bendy-butt'))
    .use(require('ssb-conn'))
    .use(require('ssb-ebt'))
    .use(require('ssb-friends'))
    .use(require('ssb-meta-feeds'))
    .use(require('ssb-tribes2'))
    .use(require('ssb-subset-rpc'))
    .use(require('ssb-index-feeds'))
    .use(require('../..'))({
    path,
    keys: ssbKeys.generate(),
    ...opts,
  })

  return sbot
}

async function waitUntilMember(person, groupId) {
  let isMember = false
  for (let i = 0; !isMember && i < 50; i++) {
    await person.tribes2
      .get(groupId)
      .then(() => {
        isMember = true
      })
      .catch(() => {})
    await p(setTimeout)(100)
  }
  if (!isMember) {
    throw new Error('Timed out waiting for person to be member of group')
  }
}

test('You replicate other people in a group', async (t) => {
  const alice = Server('alice', {
    friends: {
      hops: 1,
    },
    replicationScheduler: {
      debouncePeriod: 1,
      partialReplication: {
        0: [{}],
        1: [{ purpose: 'main' }, { purpose: 'group/additions' }],
      },
    },
  })

  const bob = Server('bob', {
    friends: {
      hops: 1,
    },
    replicationScheduler: {
      debouncePeriod: 1,
      partialReplication: {
        0: [{}],
        1: [{ purpose: 'main' }, { purpose: 'group/additions' }],
        group: [{ purpose: '$groupSecret' }],
      },
    },
  })

  const carol = Server('carol', {
    friends: {
      hops: 1,
    },
    replicationScheduler: {
      debouncePeriod: 1,
      partialReplication: {
        0: [{}],
        1: [{ purpose: 'main' }, { purpose: 'group/additions' }],
      },
    },
  })

  alice.tribes2.start()
  bob.tribes2.start()
  carol.tribes2.start()

  await p(alice.metafeeds.findOrCreate)()
  const bobRoot = await p(bob.metafeeds.findOrCreate)()
  const carolRoot = await p(carol.metafeeds.findOrCreate)()
  t.pass('created root metafeeds for alice, bob, carol')

  await Promise.all([
    p(alice.db.publish)(u.follow(bob.id)),
    p(alice.db.publish)(u.follow(carol.id)),
    p(bob.db.publish)(u.follow(alice.id)),
    p(carol.db.publish)(u.follow(alice.id)),
  ])
  t.pass('alice is mutually following bob and carol')

  const connectionBA1 = await p(bob.connect)(alice.getAddress())
  const connectionCA1 = await p(carol.connect)(alice.getAddress())
  t.pass('bob and carol connected to alice')
  await sleep(REPLICATION_TIMEOUT)
  await sleep(REPLICATION_TIMEOUT)

  t.equals(
    await alice.db.query(where(author(bob.id)), count(), toPromise()),
    1 + 2 + 1, // 1 follow + duplicate metafeed/announce + metafeed/seed
    'alice has replicated bob main'
  )
  t.equals(
    await alice.db.query(where(author(carol.id)), count(), toPromise()),
    1 + 2 + 1, // 1 follow + duplicate metafeed/announce + metafeed/seed
    'alice has replicated carol main'
  )
  t.equals(
    await bob.db.query(where(author(alice.id)), count(), toPromise()),
    2 + 2 + 1, // 2 follows + duplicate metafeed/announce + metafeed/seed
    'bob has replicated alice main'
  )
  t.equals(
    await carol.db.query(where(author(alice.id)), count(), toPromise()),
    2 + 2 + 1, // 2 follows + duplicate metafeed/announce + metafeed/seed
    'carol has replicated alice main'
  )
  t.equals(
    await bob.db.query(where(author(carol.id)), count(), toPromise()),
    0,
    'bob has NOT replicated carol main'
  )
  t.equals(
    await carol.db.query(where(author(bob.id)), count(), toPromise()),
    0,
    'carol has NOT replicated bob main'
  )

  await p(connectionBA1.close)(true)
  await p(connectionCA1.close)(true)
  t.pass('bob and carol disconnected from alice')

  const group = await alice.tribes2.create()
  t.pass('alice created a group')

  await alice.tribes2
    .addMembers(group.id, [bobRoot.id, carolRoot.id])
    .catch((err) => {
      console.error('cant add members', err)
      t.fail(err)
    })
  t.pass('alice added bob and carol to the group')

  const connectionBA2 = await p(bob.connect)(alice.getAddress())
  const connectionCA2 = await p(carol.connect)(alice.getAddress())
  t.pass('bob and carol connected to alice')
  await sleep(REPLICATION_TIMEOUT)
  await waitUntilMember(bob, group.id).catch(t.error)
  await waitUntilMember(carol, group.id).catch(t.error)
  t.pass('bob and carol are members of the group')

  await p(connectionBA2.close)(true)
  await p(connectionCA2.close)(true)
  t.pass('bob and carol disconnected from alice')

  const carolHi = await carol.tribes2
    .publish({ type: 'post', text: 'hi', recps: [group.id] })
    .catch((err) => {
      console.error('publish failed:', err)
      t.fail(err)
    })
  t.pass('carol published a message to the group')

  const connectionBC1 = await p(bob.connect)(carol.getAddress())
  t.pass('bob connected to carol')
  await sleep(REPLICATION_TIMEOUT)
  await sleep(REPLICATION_TIMEOUT)

  const msg = await p(bob.db.get)(carolHi.key).catch(t.error)
  t.equals(msg.content.text, 'hi', "bob has replicated carol's group msg")

  await p(connectionBC1.close)(true)
  await Promise.all([
    p(alice.close)(true),
    p(bob.close)(true),
    p(carol.close)(true),
  ])
})
