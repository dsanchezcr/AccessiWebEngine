import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

const isPublicIpv4 = (address: string): boolean => {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false
  }
  const [a, b, c] = octets
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 88 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && c === 113)
  )
}

const expandIpv6 = (address: string): number[] | undefined => {
  const normalized = address.toLowerCase().split('%')[0]
  if (normalized.includes('.')) return undefined
  const halves = normalized.split('::')
  if (halves.length > 2) return undefined
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  if (halves.length === 1 && left.length !== 8) return undefined
  const missing = 8 - left.length - right.length
  if (missing < 0 || (halves.length === 2 && missing < 1)) return undefined
  const groups = [...left, ...Array(missing).fill('0'), ...right].map((part) => Number.parseInt(part, 16))
  return groups.length === 8 && groups.every((part) => Number.isInteger(part) && part >= 0 && part <= 0xffff)
    ? groups
    : undefined
}

export const isPublicIp = (address: string): boolean => {
  const version = isIP(address)
  if (version === 4) return isPublicIpv4(address)
  if (version !== 6) return false

  const groups = expandIpv6(address)
  if (!groups) return false
  const [first, second, third, fourth, fifth, sixth, seventh, eighth] = groups
  if (groups.every((group) => group === 0) || groups.slice(0, 7).every((group) => group === 0) && eighth === 1) {
    return false
  }
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) {
    return false
  }
  if (first === 0x2001 && (second === 0x0000 || second === 0x0db8)) return false
  if (groups.slice(0, 5).every((group) => group === 0) && fifth === 0xffff) {
    return isPublicIpv4(`${sixth >> 8}.${sixth & 255}.${seventh >> 8}.${seventh & 255}`)
  }
  return first >= 0x2000 && first <= 0x3fff
}

const resolveAddresses = async (hostname: string): Promise<string[]> => {
  if (isIP(hostname)) return [hostname]
  const results = await lookup(hostname, { all: true, verbatim: true })
  return results.map(({ address }) => address)
}

export const resolvePublicAddress = async (
  hostname: string,
  resolver: (hostname: string) => Promise<string[]> = resolveAddresses,
): Promise<string> => {
  const addresses = await resolver(hostname)
  if (addresses.length === 0 || addresses.some((address) => !isPublicIp(address))) {
    throw new Error('The hostname must resolve only to public IP addresses.')
  }
  return addresses[0]
}

export const isIssueRepositoryAllowed = (
  owner: string,
  repo: string,
  configured: string | undefined = process.env.GITHUB_ISSUE_ALLOWED_REPOSITORIES,
): boolean => {
  if (!configured) return false
  const requested = `${owner}/${repo}`.toLowerCase()
  return configured.split(',').some((entry) => entry.trim().toLowerCase() === requested)
}

export const validatePublicUrl = async (
  value: string,
  resolver: (hostname: string) => Promise<string[]> = resolveAddresses,
): Promise<URL> => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Provide a valid public http(s) URL.')
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.port !== '' && url.port !== '80' && url.port !== '443') ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error('Only public http(s) URLs are allowed.')
  }

  await resolvePublicAddress(hostname, resolver)
  return url
}

let remoteJwks: ReturnType<typeof createRemoteJWKSet> | undefined

export const verifyBearerToken = async (authorization: string | null): Promise<JWTPayload> => {
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
  const tenant = process.env.ENTRA_B2C_TENANT_NAME
  const policy = process.env.ENTRA_B2C_SIGNUP_SIGNIN_POLICY
  const audience = process.env.ENTRA_B2C_CLIENT_ID
  const issuer = process.env.ENTRA_B2C_ISSUER
  if (!token || !tenant || !policy || !audience || !issuer) {
    throw new Error('Authentication is required or Entra ID B2C is not configured.')
  }

  const jwksUrl = new URL(
    `https://${tenant}.b2clogin.com/${tenant}.onmicrosoft.com/${policy}/discovery/v2.0/keys`,
  )
  remoteJwks ??= createRemoteJWKSet(jwksUrl)
  const { payload } = await jwtVerify(token, remoteJwks, { audience, issuer })
  if (!payload.sub) throw new Error('The access token has no subject.')
  return payload
}
