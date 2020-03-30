'use strict';

const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const tester = require('../condition-tester');

describe('*** TESTING CONDITIONS ****', () => {

    it('Checks event trigger properly', () => {
        const condition = 'event_occurs #{USER_CREATED_ACCOUNT}';
        const event = { eventType: 'USER_CREATED_ACCOUNT' };

        const result = tester.testConditionsForStatus(event, [condition]);
        expect(result).to.be.true;
    });

    it('Does a tournament check properly', () => {
        const condition = 'number_taps_in_first_N #{1::10000}';

        const mockUserResponseList = [
            { accountId: 'account-id-1', logContext: { numberTaps: 20, timeTakenMillis: 10000 } },
            { accountId: 'account-id-2', logContext: { numberTaps: 10, timeTakenMillis: 10000 } },
            { accountId: 'account-id-3', logContext: { numberTaps: 40, timeTakenMillis: 10000 } },
        ];

        const eventContext = { accountTapList: mockUserResponseList };

        const eventId1 = { eventType: 'BOOST_EXPIRED', accountId: 'account-id-1', eventContext };
        const result1 = tester.testConditionsForStatus(eventId1, [condition]);

        const eventId3 = { eventType: 'BOOST_EXPIRED', accountId: 'account-id-3', eventContext };
        const result2 = tester.testConditionsForStatus(eventId3, [condition]);

        expect(result1).to.be.false;
        expect(result2).to.be.true;
    });

});
