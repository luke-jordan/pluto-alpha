'use strict';

const config = require('config');
const logger = require('debug')('jupiter:migration:handler');
const {migrate} = require('postgres-migrations');
const AWS = require('aws-sdk');
const s3 = require('s3');

const awsRegion = config.get('aws.region');
AWS.config.update({
  'region': awsRegion
});
const migrationScriptsLocation = 'scripts';
const secretName = config.get(`secrets.names.master`);
const secretsClient = new AWS.SecretsManager({ region: awsRegion });

const client = s3.createClient({
  s3Options: {
    accessKeyId: config.get('secrets.accessKeyId'),
    secretAccessKey: config.get('secrets.secretAccessKey'),
    region: awsRegion
  }
});
const BUCKET_PREFIX = 's3://';

const fetchDBConnectionDetails = () => {
  logger('Fetching database connection details');
  let dbConfig = {};
  logger('Fetching secret with name: ', secretName);
  secretsClient.getSecretValue({ 'SecretId': secretName }, (err, fetchedSecretData) => {
    if (err) {
      logger('Error retrieving auth secret for: ', err);
      throw err;
    }
    // Decrypts secret using the associated KMS CMK.
    // Depending on whether the secret is a string or binary, one of these fields will be populated.
    logger('No error, got the secret, moving onward: ', fetchedSecretData);
    const secret = JSON.parse(fetchedSecretData.SecretString);
    dbConfig = { ...config.get('db') };
    dbConfig.user = secret.username;
    dbConfig.password = secret.password;
  });

  return dbConfig;
};


const runMigrations = (dbConfig) => {
  logger('Running Migrations');

  migrate({
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password,
    host: dbConfig.host,
    port: dbConfig.port
  }, migrationScriptsLocation).then(() => {
    logger('Migrations ran successfully');
    return 'Migrations Successful';
  }).catch((error) => {
    logger('Error occurred while running migrations: ', error);
    return 'Migrations Failed';
  });
};

const syncFilesFromS3BucketToLocalDirectory = async (bucketName, pathToLocalDirectory) => {
  logger(`Fetching script from s3 bucket ${BUCKET_PREFIX}${bucketName}`);

  const params = {
    localFile: pathToLocalDirectory,
    s3Params: {
      Bucket: bucketName,
      Prefix: BUCKET_PREFIX
    },
    deleteRemoved: true
  };

  return client.downloadDir(params);
};

const handleFailureResponseOfDownloader = (err, event) => {
    logger('unable to download:', err.stack);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'error while downloading files from s3 bucket',
        input: event
      })
    };
};

const handleSuccessResponseOfDownloader = async (dbConfig, event) => {
    logger(
        `Completed download of files from s3 bucket`
    );
    const message = await runMigrations(dbConfig);
    return {
      statusCode: 200,
      body: JSON.stringify({
        message,
        input: event
      })
    };
};

module.exports.migrate = async (event) => {
  logger('Handling request to run migrations');
  const dbConfig = fetchDBConnectionDetails();

  const bucketName = config.get('aws.bucketName');
  const downloader = syncFilesFromS3BucketToLocalDirectory(bucketName, migrationScriptsLocation);

  downloader.on('error', (err) => handleFailureResponseOfDownloader(err, event));
  downloader.on('progress', () => {
    logger('progress', downloader.progressAmount, downloader.progressTotal);
  });
  downloader.on('end', () => handleSuccessResponseOfDownloader(dbConfig, event));
};
