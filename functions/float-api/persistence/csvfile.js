'use strict';

const logger = require('debug')('jupiter:float:csvgenerate');
const config = require('config');
const moment = require('moment');

const stringify = require('csv-stringify/lib/sync');

const AWS = require('aws-sdk');
const s3 = new AWS.S3({ region: config.get('aws.region') });

module.exports.writeAndUploadCsv = async ({ filePrefix, rowsFromRds, logId }) => {
    try {
        const fileName = `${filePrefix}.${moment().format('YYYY-MM-DD')}.${logId}.csv`;

        // will start to break when we have many users, but then just switch to csv streams API
        const csvText = stringify(rowsFromRds, { header: true });

        const s3bucket = config.get('records.bucket');
        const s3key = `${filePrefix}/${fileName}`;

        const s3params = {
            ContentType: 'text/csv',
            Bucket: s3bucket,
            Key: s3key,
            Body: Buffer.from(csvText, 'utf8')
        };

        logger('Uploading with parameters: ', s3params);
        const resultOfUpload = await s3.putObject(s3params).promise();
        logger('Result of upload: ', resultOfUpload);

        return `s3://${s3bucket}//${s3key}`;
    } catch (err) {
        logger('FATAL_ERROR: Inside float CSV file upload', err);
        return false;
    }
};
