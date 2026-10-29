import { CosmosClient, type Container, type Database } from '@azure/cosmos'
import { DefaultAzureCredential } from '@azure/identity'
import type { JWTPayload } from 'jose'

export type AccessiWebUser = {
  id: string
  entraOid: string
  email?: string
  displayName?: string
  featureFlags: { autoRemediationPrPreview: boolean }
  previewAccessApproved?: boolean
  createdAt: string
}

let client: CosmosClient | undefined
let databasePromise: Promise<Database> | undefined
let containersPromise: Promise<void> | undefined

const isProduction = (): boolean =>
  ['prod', 'production'].includes((process.env.APP_ENV ?? process.env.NODE_ENV ?? '').toLowerCase())

const getDatabase = async () => {
  const endpoint = process.env.COSMOS_DB_ENDPOINT
  const connectionString = process.env.COSMOS_DB_CONNECTION_STRING ?? process.env.COSMOS_CONNECTION_STRING
  if (!client) {
    if (isProduction()) {
      if (!endpoint) throw new Error('COSMOS_DB_ENDPOINT is required in production.')
      client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() })
    } else if (connectionString) {
      client = new CosmosClient(connectionString)
    } else if (endpoint) {
      client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() })
    } else {
      throw new Error('Cosmos DB is not configured.')
    }
  }
  databasePromise ??= client.databases.createIfNotExists({ id: 'accessiweb-db' }).then(({ database }) => database)
  const database = await databasePromise
  containersPromise ??= Promise.all([
    database.containers.createIfNotExists({ id: 'scans', partitionKey: { paths: ['/scanType'] } }),
    database.containers.createIfNotExists({ id: 'remediations', partitionKey: { paths: ['/userId'] } }),
    database.containers.createIfNotExists({ id: 'users', partitionKey: { paths: ['/entraOid'] } }),
    database.containers.createIfNotExists({
      id: 'rateLimits',
      partitionKey: { paths: ['/clientKey'] },
      defaultTtl: 3600,
    }),
  ]).then(() => undefined).catch((error: unknown) => {
    containersPromise = undefined
    throw error
  })
  await containersPromise
  return database
}

const getContainer = async (id: string): Promise<Container> => {
  const database = await getDatabase()
  return database.container(id)
}

export const getOrCreateUser = async (claims: JWTPayload): Promise<AccessiWebUser> => {
  const entraOid = claims.sub
  if (!entraOid) throw new Error('The identity token has no subject.')
  const container = await getContainer('users')
  const id = `user_${entraOid}`
  try {
    const { resource } = await container.item(id, entraOid).read<AccessiWebUser>()
    if (resource) return resource
  } catch (error) {
    if ((error as { code?: number }).code !== 404) throw error
  }

  const emails = claims.emails
  const email = Array.isArray(emails) && typeof emails[0] === 'string' ? emails[0] : undefined
  const user: AccessiWebUser = {
    id,
    entraOid,
    ...(email ? { email } : {}),
    ...(typeof claims.name === 'string' ? { displayName: claims.name } : {}),
    featureFlags: { autoRemediationPrPreview: false },
    createdAt: new Date().toISOString(),
  }
  const { resource } = await container.items.upsert<AccessiWebUser>(user)
  return resource ?? user
}

export const enablePreviewForUser = async (user: AccessiWebUser): Promise<AccessiWebUser> => {
  const container = await getContainer('users')
  const updated = {
    ...user,
    featureFlags: { ...user.featureFlags, autoRemediationPrPreview: true },
  }
  await container.items.upsert(updated)
  return updated
}

export const consumeRateLimit = async (
  clientKey: string,
  limit: number,
  windowMs = 60 * 60 * 1000,
  now = Date.now(),
): Promise<boolean> => {
  const container = await getContainer('rateLimits')
  const { resources } = await container.items.query<number>({
    query: 'SELECT VALUE COUNT(1) FROM c WHERE c.createdAtEpoch > @cutoff',
    parameters: [{ name: '@cutoff', value: now - windowMs }],
  }, { partitionKey: clientKey }).fetchAll()
  if ((resources[0] ?? 0) >= limit) return false
  await container.items.create({
    id: crypto.randomUUID(),
    clientKey,
    createdAtEpoch: now,
    ttl: Math.ceil(windowMs / 1000),
  })
  return true
}

export const saveScan = async (
  scanType: 'WEB_URL' | 'SOURCE_CODE',
  target: string,
  report: unknown,
  entraOid?: string,
): Promise<string> => {
  const container = await getContainer('scans')
  const id = crypto.randomUUID()
  await container.items.create({
    id,
    scanType,
    target,
    report,
    ...(entraOid ? { entraOid } : {}),
    createdAt: new Date().toISOString(),
  })
  return id
}

export const saveRemediation = async (record: {
  id: string
  entraOid: string
  userId: string
  repoUrl: string
  branch: string
  commitSha: string
  pullRequestUrl: string
  status: 'complete'
}) => {
  const container = await getContainer('remediations')
  await container.items.create({ ...record, createdAt: new Date().toISOString() })
}

export const deleteUserData = async (user: AccessiWebUser): Promise<void> => {
  const users = await getContainer('users')
  const remediations = await getContainer('remediations')
  const scans = await getContainer('scans')
  const { resources: ownedScans } = await scans.items.query<{ id: string; scanType: 'WEB_URL' | 'SOURCE_CODE' }>({
    query: 'SELECT c.id, c.scanType FROM c WHERE c.entraOid = @entraOid',
    parameters: [{ name: '@entraOid', value: user.entraOid }],
  }).fetchAll()
  const { resources } = await remediations.items.query<{ id: string }>({
    query: 'SELECT c.id FROM c WHERE c.userId = @userId',
    parameters: [{ name: '@userId', value: user.id }],
  }, { partitionKey: user.id }).fetchAll()
  await Promise.all([
    ...resources.map(({ id }) => remediations.item(id, user.id).delete()),
    ...ownedScans.map(({ id, scanType }) => scans.item(id, scanType).delete()),
  ])
  await users.item(user.id, user.entraOid).delete()
}
