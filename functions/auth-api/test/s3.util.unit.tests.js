'use strict';

const logger = require('debug')('pluto:alpha:s3-util-tests');
const config = require('config');
const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
const proxyquire = require('proxyquire');

const getObjectStub = sinon.stub();

class mockS3 {
    constructor(any) {
        this.getObject = getObjectStub;
    }
};

const s3Util = proxyquire('../utils/s3-util', {
    'aws-sdk': {
        'S3': mockS3
    }
});

const resetStubs = () => {
    getObjectStub.reset();
};

describe('S3-Util', () => {
    beforeEach(() => {
        resetStubs();
        getObjectStub
            .withArgs({
                Bucket: config.get('s3.Buckets.jwtTestBucket'),
                Key: 'requested-key'
            })
            .returns({
                promise: () => { return {
                    AcceptRanges: 'bytes',
                    LastModified: new Date('2018-04-25T13:32:58.000Z'),
                    ContentLength: 23,
                    ETag: '"ae771fbbba6a74eeeb77754355831713"',
                    ContentType: 'text/plain',
                    Metadata: {},
                    Body: Buffer.from('requested information in bucket')
                }}
            });
    });

    it('should get requested key from config defined bucket', async () => {
        const expectedResult = 'requested information in bucket';

        const result = await s3Util.getPublicOrPrivateKey('requested-key');
        logger('result of call to s3 with requested key:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(getObjectStub).to.have.been.calledOnceWithExactly({
            Bucket: config.get('s3.Buckets.jwtTestBucket'),
            Key: 'requested-key'
        });
    });
});