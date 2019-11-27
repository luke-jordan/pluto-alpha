'use strict';

const config = require('config');
const logger = require('debug')('jupiter:migration:handler');
const {migrate} = require('postgres-migrations');
const AWS = require('aws-sdk');
const s3 = require('s3');
const httpStatus = require('http-status');

const awsRegion = config.get('aws.region');
AWS.config.update({
  'region': awsRegion
});
const migrationScriptsLocation = 'scripts';
const SECRET_NAME = config.has('secrets.names.master') ? config.get(`secrets.names.master`) : null;
const secretsClient = new AWS.SecretsManager({ region: awsRegion });

const customS3Client = s3.createClient({
    s3Client: new AWS.S3()
});
const BUCKET_NAME = config.get('aws.bucketName');
const FOLDER_CONTAINING_MIGRATION_SCRIPTS = config.get('environment');
const DOWNLOAD_PARAMS = {
    localDir: migrationScriptsLocation,
    s3Params: {
        Bucket: BUCKET_NAME,
        Prefix: FOLDER_CONTAINING_MIGRATION_SCRIPTS
    },
    deleteRemoved: true
};

module.exports.fetchDBUserAndPasswordFromSecrets = async (secretName) => {
    logger('Fetching secret with name: ', secretName);

    return new Promise((resolve) => {
        secretsClient.getSecretValue({ 'SecretId': secretName }, (err, fetchedSecretData) => {
            if (err) {
                logger('Error retrieving auth secret for: ', err);
                throw err;
            }
            // Decrypts secret using the associated KMS CMK.
            // Depending on whether the secret is a string or binary, one of these fields will be populated.
            logger('No error, got the secret, moving onward: ', fetchedSecretData);
            const secret = JSON.parse(fetchedSecretData.SecretString);

            resolve({
                user: secret.username,
                password: secret.password
            });
        });
    });
};

module.exports.updateDBConfigUserAndPassword = (dbConfig, user, password) => ({ ...dbConfig, user, password });

const handleDBConfigUsingSecrets = async (secretName, dbConfig) => {
    const { user, password } = await exports.fetchDBUserAndPasswordFromSecrets(secretName);
    if (!user || !password) {
        return dbConfig;
    }

    return exports.updateDBConfigUserAndPassword(dbConfig, user, password);
};

module.exports.fetchDBConnectionDetails = async (secretName) => {
    logger('Fetching database connection details');
    const dbConfig = { ...config.get('db') };

    if (!secretName) {
        return dbConfig;
    }

    return handleDBConfigUsingSecrets(secretName, dbConfig);
};

const runMigrations = (dbConfig) => {
  logger('Running Migrations');
  const finalDBConfig = {
      database: dbConfig.database,
      user: dbConfig.user,
      password: dbConfig.password,
      host: dbConfig.host,
      port: dbConfig.port
  };

  migrate(finalDBConfig, migrationScriptsLocation).
      then(() => {
        logger('Migrations ran successfully');
      }).catch((error) => {
        logger(`Error occurred while running migrations. Error: ${JSON.stringify(error)}`);
        throw error;
      });
};

module.exports.handleFailureResponseOfDownloader = (error) => {
    logger('Error while downloading files from s3 bucket. Error stack:', error.stack);
    throw error;
};

module.exports.successfullyDownloadedFilesProceedToRunMigrations = async (dbConfig) => {
    logger(`Completed download of files from s3 bucket`);
    await runMigrations(dbConfig);

    return {
        statusCode: httpStatus.OK,
        body: JSON.stringify({
            message: 'Migrations ran successfully'
        })
    };
};

module.exports.handleProgressResponseOfDownloader = (progressAmount, progressTotal) => {
    logger(
        `Progress in downloading files from s3 bucket. Progress Amount: ${progressAmount}, Progress Total: ${progressTotal}`
    );
};

module.exports.downloadFilesFromS3AndRunMigrations = async (dbConfig) => {
    logger(
        `Fetching scripts from s3 bucket: ${BUCKET_NAME}/${FOLDER_CONTAINING_MIGRATION_SCRIPTS} to local directory: ${BUCKET_NAME}`
    );

    const downloader = customS3Client.downloadDir(DOWNLOAD_PARAMS);
    
    downloader.on('error', (err) => exports.handleFailureResponseOfDownloader(err));
    downloader.on('progress', () => exports.handleProgressResponseOfDownloader(downloader.progressAmount, downloader.progressTotal));
    downloader.on('end', () => exports.successfullyDownloadedFilesProceedToRunMigrations(dbConfig));
};

module.exports.migrate = async () => {
  logger('Handling request to run migrations');
  try {
      const dbConfig = await exports.fetchDBConnectionDetails(SECRET_NAME);
      return await exports.downloadFilesFromS3AndRunMigrations(dbConfig);
  } catch (error) {
    logger(`Error occurred while handling request to run migrations. Error: ${JSON.stringify(error)}`);
      return {
          statusCode: httpStatus.INTERNAL_SERVER_ERROR,
          body: JSON.stringify({
              message: 'Error while handling request to run migrations'
          })
      };
  }
};
