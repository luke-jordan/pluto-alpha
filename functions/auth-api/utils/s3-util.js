const config = require('config');
const logger = require('debug')('pluto:auth:s3-util-main');
const aws = require('aws-sdk');
const s3 = new aws.S3();


// As of Wed May 29 2019 11:52:09 GMT+0200 (South Africa Standard Time) this function fails when run on localstack. Runs as expected on actual aws s3 resources.
module.exports.getPublicOrPrivateKey = async (requestedKey, authToken) => {
    // consider how to implement authentication to prevent this function from being compromised.
    // A potential solution may be s3's block public access option. Else lambda authoriser.
    logger('Running in s3Util. Recieved', requestedKey);
    const getParams = {
        Bucket: config.get('s3.Buckets.jwtTestBucket'),
        Key: requestedKey
    };
 
    logger('About to execute try/catch block with params:', getParams);
    try {
        const s3Response = await s3.getObject(getParams).promise();
        logger('s3Response', s3Response);
        let objectData = s3Response.Body.toString('utf-8');
        return objectData;
    } catch (err) {
        console.log(err);
        throw new Error(err);
    }
};
