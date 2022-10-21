// SPDX-FileCopyrightText: 2021 Andre 'Staltz' Medeiros
//
// SPDX-License-Identifier: LGPL-3.0-only

const { QL0 } = require('ssb-subset-ql')
const pickShard = require('ssb-meta-feeds/pick-shard')

function isEmptyObject(obj) {
  return Object.keys(obj).length === 0
}

/**
 * Algorithms for the "replication template" object from the SSB config.
 */
module.exports = class Template {
  constructor(leafShapes) {
    /** @type Array{*} */
    this._leafShapes = leafShapes
  }

  hasIndexLeaf() {
    return this._leafShapes.some((shape) => shape && shape.purpose === 'index')
  }

  matchBranch(branch, mainFeedId) {
    return this._matchBranch(branch, mainFeedId)
  }

  _matchBranch(branch, mainFeedId) {
    if (!branch || !Array.isArray(branch)) return false
    const [rootMF, v1MF, shardMF, leafFeed] = branch
    switch (branch.length) {
      case 0:
        return false
      case 1:
        return true
      case 2:
        return true
      case 3:
        return this._matchShard(rootMF, shardMF)
      case 4:
        return this._matchLeaf(leafFeed, rootMF.id, mainFeedId)
      default:
        return false
    }
  }

  _matchShard(rootMF, shardMF) {
    if (this._leafShapes.some(isEmptyObject)) return true
    const wantedShards = this._leafShapes.map((leaf) =>
      pickShard(rootMF.id, leaf.purpose)
    )
    return wantedShards.includes(shardMF.purpose)
  }

  _matchLeaf(leafFeed, rootID, mainID) {
    return this._leafShapes.some((shape) => {
      // Empty shape means "accept any leaf"
      if (isEmptyObject(shape)) return true

      // If present, purpose must match
      if (leafFeed.purpose !== shape.purpose) {
        return false
      }

      // If present, metadata must match
      if (shape.metadata && leafFeed.metadata) {
        // If querylang is present, match ssb-ql-0 queries
        if (shape.metadata.querylang !== leafFeed.metadata.querylang) {
          return false
        }
        if (shape.metadata.querylang === 'ssb-ql-0') {
          if (!QL0.parse(leafFeed.metadata.query)) return false
          if (shape.metadata.query) {
            const shapeQuery = { ...shape.metadata.query }
            if (shapeQuery.author === '$main') shapeQuery.author = mainID
            if (shapeQuery.author === '$root') shapeQuery.author = rootID
            if (!QL0.isEquals(shapeQuery, leafFeed.metadata.query)) {
              return false
            }
          }
        }

        // Any other metadata field must match exactly
        for (const field of Object.keys(shape.metadata)) {
          // Ignore these because we already handled them:
          if (field === 'query') continue
          if (field === 'querylang') continue

          if (typeof shape.metadata[field] === 'string') {
            const fieldValue = shape.metadata[field]
              .replace('$main', mainID)
              .replace('$root', rootID)
            if (fieldValue !== leafFeed.metadata[field]) return false
          } else if (shape.metadata[field] !== leafFeed.metadata[field]) {
            return false
          }
        }
      }

      return true
    })
  }
}
