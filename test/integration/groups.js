const test = require('tape')
const rimraf = require('rimraf')
const SecretStack = require('secret-stack')
const caps = require('ssb-caps')
const ssbKeys = require('ssb-keys')
const bendyButtFormat = require('ssb-ebt/formats/bendy-butt')
const p = require('util').promisify
const u = require('../misc/util')
const replicate = require('../../replicate')

const sleep = p(setTimeout)
const REPLICATION_TIMEOUT = 4e3

const Server = (name, opts = {}) => {
  const path = `/tmp/ssb-replication-tests-${name}`
  rimraf.sync(path)

  const sbot = SecretStack({ caps })
    .use(require('ssb-db2'))
    .use(require('ssb-db2/compat/ebt'))
    .use(require('ssb-bendy-butt'))
    .use(require('ssb-conn'))
    .use(require('ssb-ebt'))
    .use(require('ssb-friends'))
    .use(require('ssb-tribes2'))
    .use(require('ssb-meta-feeds'))
    .use(require('ssb-subset-rpc'))
    .use(require('ssb-index-feeds'))
    .use(require('../..'))({
    path,
    keys: ssbKeys.generate(),
    ...opts,
  })

  sbot.ebt.registerFormat(bendyButtFormat)

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

test.only('You replicate other people in a group', async (t) => {
  const alice = Server('alice', {
    friends: {
      hops: 1,
    },
  })

  const bob = Server('bob', {
    friends: {
      hops: 1,
    },
    replicationScheduler: {
      debouncePeriod: 1,
      partialReplication: {
        1: [{ purpose: 'main' }],
        group: [{ purpose: '$groupSecret' }],
      },
    },
  })

  const carol = Server('carol', {
    friends: {
      hops: 1,
    },
  })

  await Promise.all([
    p(alice.db.publish)(u.follow(bob.id)),
    p(alice.db.publish)(u.follow(carol.id)),
    p(bob.db.publish)(u.follow(alice.id)),
    p(carol.db.publish)(u.follow(alice.id)),
  ])

  console.log('group creating')
  const group = await alice.tribes2.create()

  console.log('group created')
  await alice.tribes2.addMembers(group.id, [bob.id, carol.id])
  console.log('added members')
  console.log('alice is', alice.id)

  //await p(bob.connect)(alice.getAddress())
  //await p(carol.connect)(alice.getAddress())
  //await sleep(REPLICATION_TIMEOUT)
  //await waitUntilMember(bob, group.id).catch(t.error)
  //await waitUntilMember(carol, group.id).catch(t.error)
  await replicate(bob, alice, { waitUntilMembersOf: group.id }).catch(t.error)
  await replicate(carol, alice, { waitUntilMembersOf: group.id }).catch(t.error)

  const carolHi = await carol.tribes2
    .publish({ text: 'hi', recps: [group.id] })
    .catch(t.error)

  console.log('carol published')
  // todo connect bob and carol

  await p(bob.db.get(carolHi.key)).catch(t.error)

  console.log('msg gotten')
  //TODO: test something
})
