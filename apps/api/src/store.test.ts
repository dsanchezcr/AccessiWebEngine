import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

// npm test builds the API before running these compiled-module tests.
let databaseAttempts = 0
let containerAttempts = 0
const container = {
  items: {
    query: () => ({ fetchAll: async () => ({ resources: [0] }) }),
    create: async () => undefined,
  },
}
const database = {
  containers: { createIfNotExists: async () => { containerAttempts += 1 } },
  container: () => container,
}
mock.module('@azure/cosmos', { namedExports: {
  CosmosClient: class {
    databases = { createIfNotExists: async () => {
      databaseAttempts += 1
      if (databaseAttempts === 1) throw new Error('Transient database initialization failure')
      return { database }
    } }
  },
} })
mock.module('@azure/identity', { namedExports: { DefaultAzureCredential: class {} } })
process.env.COSMOS_DB_ENDPOINT = 'https://database.example'
const { consumeRateLimit } = await import(new URL('../dist/apps/api/src/store.js', import.meta.url).href)

test('database initialization failures clear the cached promise and permit a successful retry', async () => {
  await assert.rejects(consumeRateLimit('test', 10), /Transient database initialization failure/)
  assert.equal(await consumeRateLimit('test', 10), true)
  assert.equal(await consumeRateLimit('test', 10), true)
  assert.equal(databaseAttempts, 2)
  assert.equal(containerAttempts, 4)
})
