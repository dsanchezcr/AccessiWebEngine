param projectName string
param environment string
param location string
param keyVaultName string
param keyVaultUri string
param cosmosAccountName string
param cosmosEndpoint string
param applicationInsightsConnectionString string
param staticWebAppOrigin string
param metaApiBaseUrl string
param metaAnalysisProvider string
param metaMuseSparkOpenUrl string
param metaMuseSparkOpenModel string
param enableMuseSparkOpenApiKey bool
param metaMuseCodeModel string
param metaSamModel string
param metaMuseWonderModel string
param metaMuseImageModel string
param githubIssueAllowedRepositories string
param enablePreviewInviteCode bool
param entraB2cTenantName string
param entraB2cClientId string
param entraB2cPolicyName string
param entraB2cIssuer string
param featureEnableAutoPrPreview bool

var suffix = uniqueString(resourceGroup().id)
var functionName = '${projectName}-${environment}-${suffix}'
var storageName = 'st${take(toLower(replace(projectName, '-', '')), 8)}${take(toLower(replace(environment, '-', '')), 4)}${take(suffix, 10)}'
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
var cosmosDataContributorRoleId = '00000000-0000-0000-0000-000000000002'
var keyVaultSecretUri = '${keyVaultUri}secrets'
var storageConnectionString = 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${az.environment().suffixes.storage}'

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  tags: {
    project: projectName
    environment: environment
  }
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true
  }
}

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${functionName}-plan'
  location: location
  kind: 'linux'
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
  properties: {
    reserved: true
  }
  tags: {
    project: projectName
    environment: environment
  }
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionName
  location: location
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    httpsOnly: true
    serverFarmId: plan.id
    siteConfig: {
      linuxFxVersion: 'NODE|22'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      cors: {
        allowedOrigins: [
          staticWebAppOrigin
        ]
        supportCredentials: false
      }
    }
  }
  tags: {
    project: projectName
    environment: environment
  }
}

resource appSettings 'Microsoft.Web/sites/config@2023-12-01' = {
  parent: functionApp
  name: 'appsettings'
  properties: {
    FUNCTIONS_EXTENSION_VERSION: '~4'
    FUNCTIONS_WORKER_RUNTIME: 'node'
    AzureWebJobsStorage: storageConnectionString
    // The Functions action sets a package URL for Linux Consumption; local package mode ('1') is unsupported.
    SCM_DO_BUILD_DURING_DEPLOYMENT: 'false'
    ENABLE_ORYX_BUILD: 'false'
    APP_ENV: environment == 'prod' ? 'production' : environment
    APPLICATIONINSIGHTS_CONNECTION_STRING: applicationInsightsConnectionString
    COSMOS_DB_ENDPOINT: cosmosEndpoint
    META_API_KEY: '@Microsoft.KeyVault(SecretUri=${keyVaultSecretUri}/meta-api-key/)'
    META_API_BASE_URL: metaApiBaseUrl
    META_ANALYSIS_PROVIDER: metaAnalysisProvider
    META_MUSE_SPARK_OPEN_URL: metaMuseSparkOpenUrl
    META_MUSE_SPARK_OPEN_MODEL: metaMuseSparkOpenModel
    ...(enableMuseSparkOpenApiKey ? {
      META_MUSE_SPARK_OPEN_API_KEY: '@Microsoft.KeyVault(SecretUri=${keyVaultSecretUri}/meta-muse-spark-open-api-key/)'
    } : {})
    META_MUSE_CODE_MODEL: metaMuseCodeModel
    META_SAM_MODEL: metaSamModel
    META_MUSE_WONDER_MODEL: metaMuseWonderModel
    META_MUSE_IMAGE_MODEL: metaMuseImageModel
    GITHUB_BOT_TOKEN: '@Microsoft.KeyVault(SecretUri=${keyVaultSecretUri}/github-bot-token/)'
    GITHUB_ISSUE_ALLOWED_REPOSITORIES: githubIssueAllowedRepositories
    ENTRA_B2C_TENANT_NAME: entraB2cTenantName
    ENTRA_B2C_CLIENT_ID: entraB2cClientId
    ENTRA_B2C_SIGNUP_SIGNIN_POLICY: entraB2cPolicyName
    ENTRA_B2C_ISSUER: entraB2cIssuer
    FEATURE_ENABLE_AUTO_PR_PREVIEW: string(featureEnableAutoPrPreview)
    ...(enablePreviewInviteCode ? {
      META_PREVIEW_INVITE_CODE: '@Microsoft.KeyVault(SecretUri=${keyVaultSecretUri}/meta-preview-invite-code/)'
    } : {})
  }
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource cosmosAccount 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' existing = {
  name: cosmosAccountName
}

resource keyVaultSecretsRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, functionApp.name, keyVaultSecretsUserRoleId)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource cosmosDataRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.name, functionApp.name, cosmosDataContributorRoleId)
  properties: {
    roleDefinitionId: '${cosmosAccount.id}/sqlRoleDefinitions/${cosmosDataContributorRoleId}'
    principalId: functionApp.identity.principalId
    scope: cosmosAccount.id
  }
}

output functionAppName string = functionApp.name
output functionAppUrl string = 'https://${functionApp.properties.defaultHostName}'
