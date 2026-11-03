import { PublicClientApplication } from '@azure/msal-browser'

const tenant = import.meta.env.VITE_ENTRA_B2C_TENANT_NAME
const policy = import.meta.env.VITE_ENTRA_B2C_SIGNUP_SIGNIN_POLICY
const authority = tenant && policy
  ? `https://${tenant}.b2clogin.com/${tenant}.onmicrosoft.com/${policy}`
  : undefined

const profilePolicy = import.meta.env.VITE_ENTRA_B2C_PROFILE_EDIT_POLICY
const profileEditAuthority = tenant && profilePolicy
  ? `https://${tenant}.b2clogin.com/${tenant}.onmicrosoft.com/${profilePolicy}`
  : undefined

export const apiScope = import.meta.env.VITE_ENTRA_B2C_API_SCOPE || 'openid'
export const loginRequest = { scopes: ['openid', 'profile', apiScope] }
export const profileEditRequest = {
  ...loginRequest,
  ...(profileEditAuthority ? { authority: profileEditAuthority } : {}),
}

export const msalInstance = new PublicClientApplication({
  auth: {
    clientId: import.meta.env.VITE_ENTRA_B2C_CLIENT_ID || '00000000-0000-0000-0000-000000000000',
    ...(authority ? { authority, knownAuthorities: [`${tenant}.b2clogin.com`] } : {}),
    redirectUri: import.meta.env.VITE_ENTRA_B2C_REDIRECT_URI || window.location.origin,
    postLogoutRedirectUri: window.location.origin,
  },
  cache: { cacheLocation: 'sessionStorage' },
})
