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
param metaMuseSparkOpenApiKey string = ''
@secure()
param githubBotToken string
@secure()
param metaPreviewInviteCode string

param metaApiBaseUrl string = ''
param metaAnalysisProvider string = 'meta'
param metaMuseSparkOpenUrl string = ''
param metaMuseSparkOpenModel string = ''
param metaMuseCodeModel string = 'muse-code'
param metaSamModel string = 'sam-3.1'
param metaMuseWonderModel string = 'muse-wonder'
param metaMuseImageModel string = 'muse-image'
param githubIssueAllowedRepositories string = ''
param entraB2cTenantName string = ''
param entraB2cClientId string = ''
param entraB2cPolicyName string = ''
param entraB2cIssuer string = ''
param featureEnableAutoPrPreview bool = false

var resourceGroupName = environment == 'pr'
  ? 'rg-${projectName}-pr-${prNumber}'
  : 'rg-${projectName}-${environment}'

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
    metaMuseSparkOpenApiKey: metaMuseSparkOpenApiKey
    githubBotToken: githubBotToken
    metaPreviewInviteCode: metaPreviewInviteCode
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
    metaAnalysisProvider: metaAnalysisProvider
    metaMuseSparkOpenUrl: metaMuseSparkOpenUrl
    metaMuseSparkOpenModel: metaMuseSparkOpenModel
    enableMuseSparkOpenApiKey: !empty(metaMuseSparkOpenApiKey)
    metaMuseCodeModel: metaMuseCodeModel
    metaSamModel: metaSamModel
    metaMuseWonderModel: metaMuseWonderModel
    metaMuseImageModel: metaMuseImageModel
    githubIssueAllowedRepositories: githubIssueAllowedRepositories
    enablePreviewInviteCode: !empty(metaPreviewInviteCode)
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
