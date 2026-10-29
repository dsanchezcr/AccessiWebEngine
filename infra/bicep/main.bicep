targetScope = 'subscription'

@minLength(3)
@maxLength(15)
param projectName string = 'accessiweb'

@allowed([
  'pr'
  'staging'
  'qa'
  'prod'
])
param environment string

param prNumber string = ''
param location string = 'eastus2'
param deploymentPrincipalId string
@allowed([
  'ServicePrincipal'
  'User'
  'Group'
  'ManagedIdentity'
])
param deploymentPrincipalType string = 'ServicePrincipal'

@secure()
param metaApiKey string
@secure()
param githubBotToken string

param metaApiBaseUrl string = ''
param metaMuseCodeModel string = 'muse-code'
param metaSamModel string = 'sam-3.1'
param entraB2cTenantName string = ''
param entraB2cClientId string = ''
param entraB2cPolicyName string = ''
param entraB2cIssuer string = ''
param featureEnableAutoPrPreview bool = false

var resourceGroupName = environment == 'pr'
  ? '${projectName}-pr-${prNumber}'
  : '${projectName}-${environment}'

resource resourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: {
    project: projectName
    environment: environment
    managedBy: 'infra/bicep'
    ...(environment == 'pr' ? { pullRequest: prNumber } : {})
  }
}

module keyVault 'modules/keyvault.bicep' = {
  name: 'keyvault-${uniqueString(resourceGroup.id)}'
  scope: resourceGroup
  params: {
    projectName: projectName
    environment: environment
    deploymentPrincipalId: deploymentPrincipalId
    deploymentPrincipalType: deploymentPrincipalType
    metaApiKey: metaApiKey
    githubBotToken: githubBotToken
  }
}

module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring-${uniqueString(resourceGroup.id)}'
  scope: resourceGroup
  params: {
    projectName: projectName
    environment: environment
    location: location
  }
}

module cosmos 'modules/cosmosdb.bicep' = {
  name: 'cosmos-${uniqueString(resourceGroup.id)}'
  scope: resourceGroup
  params: {
    projectName: projectName
    environment: environment
    location: location
    keyVaultName: keyVault.outputs.keyVaultName
  }
}

module staticWebApp 'modules/staticwebapp.bicep' = {
  name: 'staticwebapp-${uniqueString(resourceGroup.id)}'
  scope: resourceGroup
  params: {
    projectName: projectName
    environment: environment
    location: location
  }
}

module functionApp 'modules/functionapp.bicep' = {
  name: 'functionapp-${uniqueString(resourceGroup.id)}'
  scope: resourceGroup
  params: {
    projectName: projectName
    environment: environment
    location: location
    keyVaultName: keyVault.outputs.keyVaultName
    keyVaultUri: keyVault.outputs.keyVaultUri
    cosmosAccountName: cosmos.outputs.cosmosAccountName
    cosmosEndpoint: cosmos.outputs.cosmosEndpoint
    applicationInsightsConnectionString: monitoring.outputs.applicationInsightsConnectionString
    staticWebAppOrigin: staticWebApp.outputs.staticWebAppUrl
    metaApiBaseUrl: metaApiBaseUrl
    metaMuseCodeModel: metaMuseCodeModel
    metaSamModel: metaSamModel
    entraB2cTenantName: entraB2cTenantName
    entraB2cClientId: entraB2cClientId
    entraB2cPolicyName: entraB2cPolicyName
    entraB2cIssuer: entraB2cIssuer
    featureEnableAutoPrPreview: featureEnableAutoPrPreview
  }
}

output staticWebAppUrl string = staticWebApp.outputs.staticWebAppUrl
output staticWebAppName string = staticWebApp.outputs.staticWebAppName
output functionAppUrl string = functionApp.outputs.functionAppUrl
output functionAppName string = functionApp.outputs.functionAppName
output resourceGroupName string = resourceGroup.name
