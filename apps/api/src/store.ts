import { CosmosClient, type Container } from '@azure/cosmos'
import type { JWTPayload } from 'jose'

export type AccessiWebUser = {
  id: string
  entraOid: string
  email?: string
  displayName?: string
  featureFlags: { autoRemediationPrPreview: boolean }
  createdAt: string
}

let client: CosmosClient | undefined

const getDatabase = async () => {
  const connectionString = process.env.COSMOS_CONNECTION_STRING
  const databaseId = process.env.COSMOS_DATABASE_ID
  if (!connectionString || !databaseId) throw new Error('Cosmos DB is not configured.')
  client ??= new CosmosClient(connectionString)
  const { database } = await client.databases.createIfNotExists({ id: databaseId })
  return database
}

const getContainer = async (id: string, partitionKey: string): Promise<Container> => {
  const database = await getDatabase()
  const { container } = await database.containers.createIfNotExists({
    id,
    partitionKey: { paths: [partitionKey] },
  })
  return container
}

export const getOrCreateUser = async (claims: JWTPayload): Promise<AccessiWebUser> => {
  const entraOid = claims.sub
  if (!entraOid) throw new Error('The identity token has no subject.')
  const container = await getContainer('users', '/entraOid')
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
  const container = await getContainer('users', '/entraOid')
  const updated = {
    ...user,
    featureFlags: { ...user.featureFlags, autoRemediationPrPreview: true },
  }
  await container.items.upsert(updated)
  return updated
}

export const saveScan = async (
  scanType: 'WEB_URL' | 'SOURCE_CODE',
  target: string,
  report: unknown,
): Promise<string> => {
  const container = await getContainer('scans', '/scanType')
  const id = crypto.randomUUID()
  await container.items.create({
    id,
    scanType,
    target,
    report,
    createdAt: new Date().toISOString(),
  })
  return id
}

export const saveRemediation = async (record: {
  id: string
  entraOid: string
  repoUrl: string
  branch: string
  commitSha: string
  pullRequestUrl: string
  status: 'complete'
}) => {
  const container = await getContainer('remediations', '/entraOid')
  await container.items.create({ ...record, createdAt: new Date().toISOString() })
}

export const deleteUserData = async (user: AccessiWebUser): Promise<void> => {
  const users = await getContainer('users', '/entraOid')
  const remediations = await getContainer('remediations', '/entraOid')
  const { resources } = await remediations.items.query<{ id: string }>({
    query: 'SELECT c.id FROM c WHERE c.entraOid = @entraOid',
    parameters: [{ name: '@entraOid', value: user.entraOid }],
  }).fetchAll()
  await Promise.all(resources.map(({ id }) =>
    remediations.item(id, user.entraOid).delete(),
  ))
  await users.item(user.id, user.entraOid).delete()
}
