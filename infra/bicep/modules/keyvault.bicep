param projectName string
param environment string
param deploymentPrincipalId string
param deploymentPrincipalType string
@secure()
param metaApiKey string
@secure()
param githubBotToken string
@secure()
param metaPreviewInviteCode string

var suffix = uniqueString(resourceGroup().id)
var compactProject = take(toLower(replace(projectName, '-', '')), 8)
var compactEnvironment = take(toLower(replace(environment, '-', '')), 4)
var vaultName = '${compactProject}${compactEnvironment}${take(suffix, 10)}'
var secretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: resourceGroup().location
  tags: {
    project: projectName
    environment: environment
  }
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: environment == 'prod'
    publicNetworkAccess: 'Enabled'
  }
}

resource deploymentSecretsRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, deploymentPrincipalId, secretsOfficerRoleId)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsOfficerRoleId)
    principalId: deploymentPrincipalId
    principalType: deploymentPrincipalType
  }
}

resource metaSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'meta-api-key'
  properties: {
    value: metaApiKey
    attributes: {
      enabled: true
    }
  }
  dependsOn: [
    deploymentSecretsRole
  ]
}

resource githubSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'github-bot-token'
  properties: {
    value: githubBotToken
    attributes: {
      enabled: true
    }
  }
  dependsOn: [
    deploymentSecretsRole
  ]
}

resource previewInviteSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(metaPreviewInviteCode)) {
  parent: vault
  name: 'meta-preview-invite-code'
  properties: {
    value: metaPreviewInviteCode
    attributes: {
      enabled: true
    }
  }
  dependsOn: [
    deploymentSecretsRole
  ]
}

output keyVaultName string = vault.name
output keyVaultUri string = vault.properties.vaultUri
