// SPDX-FileCopyrightText: 2022 Jacob Karlsson <jacob.karlsson95@gmail.com>
//
// SPDX-License-Identifier: CC0-1.0

const { promisify: p } = require('util')
const pull = require('pull-stream')
const cat = require('pull-cat')
const deepEqual = require('fast-deep-equal')

/**
 * Fully replicates person1's feed to person2 and vice versa
 */
module.exports = async function replicate(person1, person2, opts = {}) {
  // Replicate self
  person1.ebt.request(person1.id, true)
  person2.ebt.request(person2.id, true)

  // Replicate each other's main feeds
  person1.ebt.request(person2.id, true)
  person2.ebt.request(person1.id, true)

  // Replicate each other's metafeed tree
  await new Promise((res, rej) => {
    pull(
      cat([
        person1.metafeeds.branchStream({ old: true, live: false }),
        person2.metafeeds.branchStream({ old: true, live: false }),
      ]),
      pull.flatten(),
      pull.map((feed) => feed.id),
      pull.unique(),
      pull.drain(
        (feedId) => {
          person1.ebt.request(feedId, true)
          person2.ebt.request(feedId, true)
        },
        (err) => {
          if (err) rej(err)
          else res()
        }
      )
    )
  })

  // Establish a network connection
  const conn = await p(person1.connect)(person2.getAddress())

  // Wait until both have replicated
  let inSync = false
  while (!inSync) {
    await p(setTimeout)(100)
    const newClock1 = await p(person1.getVectorClock)()
    const newClock2 = await p(person2.getVectorClock)()
    inSync = deepEqual(newClock1, newClock2)
  }

  // Wait until they have computed that they are members of the group
  if (opts.waitUntilMembersOf) {
    await waitUntilMember(person1, opts.waitUntilMembersOf)
    await waitUntilMember(person2, opts.waitUntilMembersOf)
  }

  await p(conn.close)(true)
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
