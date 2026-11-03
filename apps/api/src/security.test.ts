import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isIssueRepositoryAllowed,
  isPublicIp,
  resolvePublicAddress,
  validatePublicUrl,
} from './security.ts'

test('public URL validation blocks private, local, and non-web destinations', async () => {
  const resolver = async (hostname: string) => hostname === 'public.example' ? ['93.184.216.34'] : ['10.0.0.5']
  await assert.rejects(validatePublicUrl('http://127.0.0.1', resolver), /public IP/)
  await assert.rejects(validatePublicUrl('http://example.local', resolver), /public http/)
  await assert.rejects(validatePublicUrl('ftp://public.example', resolver), /public http/)
  await assert.rejects(validatePublicUrl('https://public.example:8443', resolver), /public http/)
  await assert.rejects(validatePublicUrl('https://private.example', resolver), /public IP/)
  assert.equal((await validatePublicUrl('https://public.example/path', resolver)).hostname, 'public.example')
  assert.equal(await resolvePublicAddress('public.example', resolver), '93.184.216.34')
  await assert.rejects(resolvePublicAddress('private.example', resolver), /public IP/)
})

test('IP checks reject special-purpose IPv4 and IPv6 addresses', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.20.1.1', '169.254.1.1', '192.168.1.1', '::1', 'fc00::1', 'fe80::1', '::ffff:7f00:1', '2001:db8::1']) {
    assert.equal(isPublicIp(address), false, `${address} should not be public`)
  }
  assert.equal(isPublicIp('93.184.216.34'), true)
  assert.equal(isPublicIp('2606:4700:4700::1111'), true)
})

test('DNS pinning prefers public IPv4 regardless of DNS order without ignoring unsafe answers', async () => {
  const ipv4 = '93.184.216.34'
  const ipv6 = '2606:4700:4700::1111'
  for (const addresses of [[ipv6, ipv4], [ipv4, ipv6]]) {
    assert.equal(await resolvePublicAddress('public.example', async () => addresses), ipv4)
  }
  assert.equal(await resolvePublicAddress('ipv6.example', async () => [ipv6]), ipv6)
  for (const addresses of [[ipv4, '::1'], [ipv6, '10.0.0.1'], []]) {
    await assert.rejects(resolvePublicAddress('unsafe.example', async () => addresses), /public IP/)
  }
})

test('GitHub bot issue writes require an exact configured repository allowlist', () => {
  assert.equal(isIssueRepositoryAllowed('example', 'site', 'example/site,other/project'), true)
  assert.equal(isIssueRepositoryAllowed('EXAMPLE', 'SITE', 'example/site'), true)
  assert.equal(isIssueRepositoryAllowed('example', 'site-admin', 'example/site'), false)
  assert.equal(isIssueRepositoryAllowed('example', 'site', ''), false)
})
