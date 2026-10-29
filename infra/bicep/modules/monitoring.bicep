param projectName string
param environment string
param location string

var suffix = uniqueString(resourceGroup().id)
var workspaceName = '${projectName}-${environment}-${suffix}-law'
var insightsName = '${projectName}-${environment}-${suffix}-appi'

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  tags: {
    project: projectName
    environment: environment
  }
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: environment == 'prod' ? 90 : 30
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: insightsName
  location: location
  kind: 'web'
  tags: {
    project: projectName
    environment: environment
  }
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    RetentionInDays: environment == 'prod' ? 90 : 30
    DisableIpMasking: false
  }
}

output logAnalyticsWorkspaceId string = workspace.id
output applicationInsightsConnectionString string = applicationInsights.properties.ConnectionString
