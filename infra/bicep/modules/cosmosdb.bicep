param projectName string
param environment string
param location string
param keyVaultName string

var suffix = uniqueString(resourceGroup().id)
var accountName = '${projectName}-${environment}-${suffix}'
var databaseOptions = environment == 'prod'
  ? {
      autoscaleSettings: {
        maxThroughput: 4000
      }
    }
  : {}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource account 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' = {
  name: accountName
  location: location
  kind: 'GlobalDocumentDB'
  tags: {
    project: projectName
    environment: environment
  }
  properties: {
    databaseAccountOfferType: 'Standard'
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    capabilities: environment == 'prod'
      ? []
      : [
          {
            name: 'EnableServerless'
          }
        ]
    enableAutomaticFailover: environment == 'prod'
    enableMultipleWriteLocations: false
    disableLocalAuth: false
    publicNetworkAccess: 'Enabled'
  }
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-05-15' = {
  parent: account
  name: 'accessiweb-db'
  properties: {
    resource: {
      id: 'accessiweb-db'
    }
    options: databaseOptions
  }
}

resource scans 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: database
  name: 'scans'
  properties: {
    resource: {
      id: 'scans'
      partitionKey: {
        paths: [
          '/scanType'
        ]
        kind: 'Hash'
      }
    }
    options: {}
  }
}

resource remediations 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: database
  name: 'remediations'
  properties: {
    resource: {
      id: 'remediations'
      partitionKey: {
        paths: [
          '/userId'
        ]
        kind: 'Hash'
      }
    }
    options: {}
  }
}

resource users 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: database
  name: 'users'
  properties: {
    resource: {
      id: 'users'
      partitionKey: {
        paths: [
          '/entraOid'
        ]
        kind: 'Hash'
      }
    }
    options: {}
  }
}

resource rateLimits 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: database
  name: 'rateLimits'
  properties: {
    resource: {
      id: 'rateLimits'
      partitionKey: {
        paths: [
          '/clientKey'
        ]
        kind: 'Hash'
      }
      defaultTtl: 3600
    }
    options: {}
  }
}

resource cosmosConnectionSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'cosmos-connection-string'
  properties: {
    value: account.listConnectionStrings().connectionStrings[0].connectionString
    attributes: {
      enabled: true
    }
  }
  dependsOn: [
    database
    scans
    remediations
    users
    rateLimits
  ]
}

output cosmosAccountName string = account.name
output cosmosAccountId string = account.id
output cosmosEndpoint string = account.properties.documentEndpoint
