'use strict';

const config = require('config');
const logger = require('debug')('jupiter:migration:handler');
const fs = require('fs');

const { migrate } = require('postgres-migrations');

const AWS = require('aws-sdk');
const s3 = require('s3');

const httpStatus = require('http-status');

const awsRegion = config.get('aws.region');
AWS.config.update({
  'region': awsRegion
});

const migrationScriptsLocation = config.get('scripts.location');
const SECRET_NAME = config.has('secrets.names.master') ? config.get(`secrets.names.master`) : null;

const customS3Client = s3.createClient({
    s3Client: new AWS.S3()
});

const BUCKET_NAME = config.get('s3.bucket');
const FOLDER_CONTAINING_MIGRATION_SCRIPTS = config.get('s3.folder');

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
    const secretsClient = new AWS.SecretsManager({ region: awsRegion });

    return new Promise((resolve, reject) => {
        secretsClient.getSecretValue({ 'SecretId': secretName }, (err, fetchedSecretData) => {
            if (err) {
                logger('Error retrieving auth secret for: ', err);
                reject(err);
            }
            // Decrypts secret using the associated KMS CMK.
            // logger('No error, got the secret, moving onward: ', fetchedSecretData);
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

module.exports.runMigrations = (dbConfig, resolve, reject) => {
  const finalDBConfig = {
      database: dbConfig.database,
      user: dbConfig.user,
      password: dbConfig.password,
      host: dbConfig.host,
      port: dbConfig.port
  };

  logger('Config set, running migrations');
  
  migrate(finalDBConfig, migrationScriptsLocation).
      then(() => {
        logger('Migrations ran successfully');
        resolve({
            statusCode: httpStatus.OK,
            body: JSON.stringify({
                message: 'Migrations ran successfully'
            })
        });
      }).catch((error) => {
        logger(`Error occurred while running migrations. Error: ${JSON.stringify(error)}`);
        reject(error);
      });
};

module.exports.handleFailureResponseOfDownloader = (error, reject) => {
    logger('Error while downloading files from s3 bucket. Error stack:', error.stack);
    reject(error);
};

module.exports.successfullyDownloadedFilesProceedToRunMigrations = async (dbConfig, resolve, reject) => {
    logger(`Completed download of files from s3 bucket`);
    // the S3 wrapper seems to cache the files and not download again if they are the same, so repeat runs
    // with a warm start can result in "0" prints in the download progress, even though files are there.
    // to avoid ambiguity and ensure thorough logging, doing this quick loop
    
    fs.readdir(migrationScriptsLocation, (err, files) => {
        if (err) {
            logger('Error reading files, check download logs');
            reject(err);
        }

        if (!files) {
            logger('Migration files do not exist. Cannot run migrations');
            reject(new Error('Migration files do not exist'));
        }

        files.forEach((file) => logger(file));
        exports.runMigrations(dbConfig, resolve, reject);
    });
};

module.exports.handleProgressResponseOfDownloader = (progressAmount, progressTotal) => {
    logger(
        `Progress in downloading files from s3 bucket. Progress Amount: ${progressAmount}, Progress Total: ${progressTotal}`
    );
};

module.exports.downloadFilesFromS3AndRunMigrations = async (dbConfig) => {
    logger(
        `Fetching scripts from s3 bucket: ${BUCKET_NAME}/${FOLDER_CONTAINING_MIGRATION_SCRIPTS} to local directory: ${migrationScriptsLocation}`
    );

    const downloader = customS3Client.downloadDir(DOWNLOAD_PARAMS);

    return new Promise((resolve, reject) => {
        downloader.on('progress', () => exports.handleProgressResponseOfDownloader(downloader.progressAmount, downloader.progressTotal));
        downloader.on('error', (err) => exports.handleFailureResponseOfDownloader(err, reject));
        downloader.on('end', () => exports.successfullyDownloadedFilesProceedToRunMigrations(dbConfig, resolve, reject));
    });
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
