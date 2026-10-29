param projectName string
param environment string
param location string

var suffix = uniqueString(resourceGroup().id)
var siteName = '${projectName}-${environment}-${take(suffix, 8)}'
var skuName = contains([
  'qa'
  'prod'
], environment) ? 'Standard' : 'Free'

resource staticWebApp 'Microsoft.Web/staticSites@2022-09-01' = {
  name: siteName
  location: location
  sku: {
    name: skuName
    tier: skuName
  }
  tags: {
    project: projectName
    environment: environment
  }
  properties: {
    stagingEnvironmentPolicy: 'Enabled'
    allowConfigFileUpdates: true
    provider: 'Custom'
    publicNetworkAccess: 'Enabled'
  }
}

output staticWebAppName string = staticWebApp.name
output staticWebAppUrl string = 'https://${staticWebApp.properties.defaultHostname}'
