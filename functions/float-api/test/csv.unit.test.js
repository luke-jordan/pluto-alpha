'use strict';

const logger = require('debug')('jupiter:float:csv-test');
const config = require('config');
const uuid = require('uuid/v4');
const moment = require('moment');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const helper = require('./test.helper');

const momentStub = sinon.stub();
const putObjectSub = sinon.stub();

class MockS3Client {
    constructor () { 
        this.putObject = putObjectSub;
    }
}

const handler = proxyquire('../persistence/csvfile', {
    'aws-sdk': { 'S3': MockS3Client },
    'moment': momentStub,
    '@noCallThru': true
});

describe('*** UNIT TEST FLOAT CSV WRITE AND UPLOAD ***', async () => {

    beforeEach(() => {
        helper.resetStubs(putObjectSub, momentStub);
    });

    it('Writes and uploads csv file', async () => {
        const testLogId = uuid();
        const testCurrentTime = moment();

        putObjectSub.returns({ promise: () => ({ }) });
        momentStub.returns({ format: () => testCurrentTime.format('YYYY-MM-DD')});

        const expectedArgs = {
            ContentType: 'text/csv',
            Bucket: config.get('records.bucket'),
            Key: `test_prefix/test_prefix.${testCurrentTime.format('YYYY-MM-DD')}.${testLogId}.csv`,
            Body: Buffer.from('name,surname\nJohn,Doe\nJane,Doe\n', 'utf-8')
        };

        const params = {
            filePrefix: 'test_prefix',
            rowsFromRds: [
                { name: 'John', surname: 'Doe' },
                { name: 'Jane', surname: 'Doe' }
            ],
            logId: testLogId
        };

        const resultOfUpload = await handler.writeAndUploadCsv(params);
        logger('Result of csv upload:', resultOfUpload);
        
        expect(resultOfUpload).to.exist;
        expect(resultOfUpload).to.deep.equal(`s3://floatrecordsbucket//test_prefix/test_prefix.${testCurrentTime.format('YYYY-MM-DD')}.${testLogId}.csv`);
        expect(putObjectSub).to.have.been.calledOnceWithExactly(expectedArgs);
    });

    it('Catches thrown errors', async () => {
        const testLogId = uuid();
        const testCurrentTime = moment();

        momentStub.returns({ format: () => testCurrentTime.format('YYYY-MM-DD')});
        putObjectSub.throws(new Error('Upload error'));

        const expectedArgs = {
            ContentType: 'text/csv',
            Bucket: config.get('records.bucket'),
            Key: `test_prefix/test_prefix.${testCurrentTime.format('YYYY-MM-DD')}.${testLogId}.csv`,
            Body: Buffer.from('name,surname\nJohn,Doe\nJane,Doe\n', 'utf-8')
        };

        const params = {
            filePrefix: 'test_prefix',
            rowsFromRds: [
                { name: 'John', surname: 'Doe' },
                { name: 'Jane', surname: 'Doe' }
            ],
            logId: testLogId
        };

        const resultOfUpload = await handler.writeAndUploadCsv(params);
        logger('Result of csv upload:', resultOfUpload);
        
        expect(resultOfUpload).to.exist;
        expect(resultOfUpload).to.deep.equal(false);
        expect(putObjectSub).to.have.been.calledOnceWithExactly(expectedArgs);
    });
});
