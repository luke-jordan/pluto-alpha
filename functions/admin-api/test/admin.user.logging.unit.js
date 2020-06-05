'use strict';

const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const helper = require('./test.helper');

const lamdbaInvokeStub = sinon.stub();
const publishEventStub = sinon.stub();
const getObjectStub = sinon.stub();
const uploadStub = sinon.stub();
const momentStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

class MockS3Client {
    constructor () { 
        this.getObject = getObjectStub;
        this.upload = uploadStub;
    }
}

const handler = proxyquire('../admin-user-logging', {
    'publish-common': {
        'publishUserEvent': publishEventStub
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient,
        'S3': MockS3Client
    },
    'moment': momentStub
});

describe('*** UNIT TEST ADMIN USER LOGGING ***', () => {
    const testSystemId = uuid();
    const testAdminId = uuid();

    const testFile = 'JVBERi0xLjUKJdDUxdgKNiAwIG9iago8PAovTGVuZ3RoIDE5NTYgICAgICAKL0ZpbHRlci...';

    it('Writes user log', async () => {
        const expectedResult = { publishResult: { result: 'SUCCESS' }};

        const expectedUploadArgs = {
            Bucket: config.get('s3.binaries.bucket'),
            Key: `${testSystemId}/user_documents.pdf`,
            Body: Buffer.from(testFile, 'base64')
        };

        const expectedPublishOptions = {
            initiator: testAdminId,
            context: {
                systemWideUserId: testSystemId,
                note: 'User has proved their identity.',
                binaryS3Key: `${testSystemId}/user_documents.pdf`
            }
        };

        const testUploadResult = { Location: `${testSystemId}/user_documents.pdf` };
        uploadStub.returns({ promise: () => testUploadResult });
        publishEventStub.resolves({ result: 'SUCCESS' });

        const eventBody = {
            systemWideUserId: testSystemId,
            eventType: 'VERIFIED_AS_PERSON',
            note: 'User has proved their identity.',
            binaryFile: {
                fileName: 'user_documents.pdf',
                fileContent: testFile
            }
        };

        const testEvent = helper.wrapEvent(eventBody, testAdminId, 'SYSTEM_ADMIN');

        const resultOfLog = await handler.writeLog(testEvent);

        expect(resultOfLog).to.exist;
        expect(resultOfLog).to.have.property('statusCode', 200);
        expect(resultOfLog.headers).to.deep.equal(helper.expectedHeaders);
        expect(resultOfLog.body).to.deep.equal(JSON.stringify(expectedResult));
        expect(uploadStub).to.have.been.calledOnceWithExactly(expectedUploadArgs);
        expect(publishEventStub).to.have.been.calledOnceWithExactly(testSystemId, 'VERIFIED_AS_PERSON', expectedPublishOptions);
    });

    it('Fetches user log', async () => {
        const testTimestamp = moment().subtract(5, 'days').valueOf();
        const testEndDate = moment().valueOf();

        const testContext = {
            systemWideUserId: testSystemId,
            note: 'User has proved their identity.',
            binaryS3Key: `${testSystemId}/user_documents.pdf`
        };

        const expectedResult = [{
            initiator: 'USER',
            context: JSON.stringify(testContext),
            interface: 'MOBILE_APP',
            timestamp: testTimestamp,
            userId: testSystemId,
            eventType: 'VERIFIED_AS_PERSON',
            binaryFile: testFile
        }];

        const expectedS3Params = {
            Bucket: config.get('s3.binaries.bucket'),
            Key: `${testSystemId}/user_documents.pdf`
        };

        const expectedLogPayload = {
            endDate: testEndDate,
            eventTypes: ['VERIFIED_AS_PERSON'],
            startDate: testTimestamp,
            userId: testSystemId
        };

        const expectedLogFromLambda = {
            StatusCode: 200,
            Payload: JSON.stringify({
                result: 'success',
                userEvents: {
                    totalCount: 1,
                    userEvents: [{
                        initiator: 'USER',
                        context: JSON.stringify(testContext),
                        interface: 'MOBILE_APP',
                        timestamp: testTimestamp,
                        userId: testSystemId,
                        eventType: 'VERIFIED_AS_PERSON'
                    }]
                }
            })
        };

        lamdbaInvokeStub.returns({ promise: () => expectedLogFromLambda });
        getObjectStub.returns({ promise: () => ({ Body: { toString: () => testFile }}) });
        momentStub.returns({ valueOf: () => testEndDate });

        const eventBody = {
            systemWideUserId: testSystemId,
            eventType: 'VERIFIED_AS_PERSON',
            timestamp: testTimestamp
        };

        const testEvent = helper.wrapQueryParamEvent(eventBody, testAdminId, 'SYSTEM_ADMIN');

        const userLog = await handler.fetchLog(testEvent);

        expect(userLog).to.exist;
        expect(userLog).to.have.property('statusCode', 200);
        expect(userLog.headers).to.deep.equal(helper.expectedHeaders);
        expect(userLog.body).to.deep.equal(JSON.stringify(expectedResult));
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(helper.wrapLambdaInvoc(config.get('lambdas.userHistory'), false, expectedLogPayload));
        expect(getObjectStub).to.have.been.calledOnceWithExactly(expectedS3Params);
    });
});
