'use strict';

// const logger = require('debug')('jupiter:friends:test');
const uuid = require('uuid/v4');
const moment = require('moment');

const proxyquire = require('proxyquire').noCallThru();
const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const expect = chai.expect;

const helper = require('./test-helper');

const fetchAlertStub = sinon.stub();
const updateAlertStub = sinon.stub();

const LOG_TYPES_FOR_ALERT = ['FRIENDSHIP_REQUESTED', 'FRIENDSHIP_ACCEPTED'];

const handler = proxyquire('../friend-alert-handler', {
    './persistence/write.friends': {
        'updateAlertLogsToViewedForUser': updateAlertStub,
        '@noCallThru': true
    },
    './persistence/read.friends': {
        'fetchAlertLogsForUser': fetchAlertStub,
        '@noCallThru': true
    }
    
});

describe('*** UNIT TEST FRIEND ALERT ***', () => {

    const testLogId = uuid();
    const testSystemId = uuid();
    const testAlertedUserId = uuid();
    const testAlertTargetUserId = uuid();

    const testUpdatedTime = moment().format();

    const mockAlertLog = {
        logId: testLogId,
        isAlertActive: true,
        toAlertUserId: testAlertTargetUserId,
        alertedUserId: testAlertedUserId,
        logType: 'FRIENDSHIP_REQUESTED'
    };

    beforeEach(() => {
        helper.resetStubs(fetchAlertStub, updateAlertStub);
    });

    it('Fetches friend alerts, single alert', async () => {
        const mockEvent = helper.wrapParamsWithPath({}, 'fetch', testSystemId);
        fetchAlertStub.resolves([mockAlertLog]);
        const fetchResult = await handler.directAlertRequest(mockEvent);

        expect(fetchResult).to.exist;
        expect(fetchResult).to.have.property('statusCode', 200);
        expect(fetchResult).to.have.property('body');
        const parsedResult = JSON.parse(fetchResult.body);
        expect(parsedResult).to.deep.equal({
            result: 'SINGLE_ALERT',
            logIds: [testLogId],
            alertLog: {
                logId: testLogId,
                logType: 'FRIENDSHIP_REQUESTED'
            }
        });

        expect(fetchAlertStub).to.have.been.calledOnceWithExactly(testSystemId, LOG_TYPES_FOR_ALERT);

    });

    it('Fetches friend alerts, multiple alerts', async () => {
        const mockEvent = helper.wrapParamsWithPath({}, 'fetch', testSystemId);
        fetchAlertStub.resolves([mockAlertLog, mockAlertLog]);
        const fetchResult = await handler.directAlertRequest(mockEvent);

        expect(fetchResult).to.exist;
        expect(fetchResult).to.have.property('statusCode', 200);
        expect(fetchResult).to.have.property('body');
        const parsedResult = JSON.parse(fetchResult.body);
        expect(parsedResult).to.deep.equal({
            result: 'MULTIPLE_ALERTS',
            logIds: [testLogId, testLogId],
            logsOfType: 'FRIENDSHIP_REQUESTED'
        });
        
        expect(fetchAlertStub).to.have.been.calledOnceWithExactly(testSystemId, LOG_TYPES_FOR_ALERT);

    });

    it('Marks alerts as viewed', async () => {
        const mockEvent = helper.wrapParamsWithPath({ logIds: [testLogId] }, 'viewed', testSystemId);
        updateAlertStub.resolves([{ updatedTime: testUpdatedTime }]);
        const updateResult = await handler.directAlertRequest(mockEvent);

        expect(updateResult).to.exist;
        expect(updateResult).to.have.property('statusCode', 200);
        expect(updateResult).to.have.property('body');
        const parsedResult = JSON.parse(updateResult.body);
        expect(parsedResult).to.deep.equal({
            result: 'UPDATED',
            resultOfUpdate: [{ updatedTime: testUpdatedTime }]
        });

        expect(updateAlertStub).to.have.been.calledOnceWithExactly(testSystemId, [testLogId]);

    });

});
