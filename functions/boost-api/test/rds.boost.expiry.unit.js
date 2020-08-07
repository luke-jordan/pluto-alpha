'use strict';

const moment = require('moment');

const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));

const sinon = require('sinon');

const queryStub = sinon.stub();
const updateStub = sinon.stub();

const { resetStubs } = require('./boost.test.helper');

const proxyquire = require('proxyquire').noCallThru();

const rds = proxyquire('../persistence/rds.boost', {
    'rds-common': class {
        constructor () {
            this.selectQuery = queryStub;
            this.updateRecord = updateStub;
        }
    },
    '@noCallThru': true
});

describe('*** UNIT TEST BOOST COMPLETION METHODS ***', async () => {

    beforeEach(() => resetStubs(queryStub, updateStub));

    it('Ends finished tournaments', async () => {
        const findQuery = `select * from boost_data.boost where active = true and end_time > current_timestamp ` +
            `and ($1 = any(flags))`;
        const selectQuery = `select boost_status, count(*) from boost_data.boost_account_status where boost_id = $1 group by boost_status`;
        const updateQuery = `update boost_data.boost set end_time = current_timestamp where boost_id in ($1) returning updated_time`;

        const testUpdatedTime = moment().format();

        const mockTournamentFromRds = (boostId) => ({
            'boost_id': boostId,
            'active': true,
            'flags': ['FRIEND_TOURNAMENT']
        });

        const firstTournament = mockTournamentFromRds('boost-id-1');
        const secondTournament = mockTournamentFromRds('boost-id-2');

        queryStub.withArgs(findQuery, ['FRIEND_TOURNAMENT']).resolves([firstTournament, secondTournament]);
        
        queryStub.withArgs(selectQuery, ['boost-id-1']).resolves([{ 'boost_status': 'PENDING', 'count': 8 }]);
        queryStub.withArgs(selectQuery, ['boost-id-2']).resolves([{ 'boost_status': 'PENDING', 'count': 55 }, { 'boost_status': 'OFFERED', 'count': 15 }]);
        
        updateStub.resolves({ rows: [{ 'updated_time': testUpdatedTime }]});

        const resultOfOperations = await rds.endFinishedTournaments();

        expect(resultOfOperations).to.exist;
        expect(resultOfOperations).to.deep.equal({ updatedTime: moment(testUpdatedTime) });
        expect(queryStub).to.have.been.calledWithExactly(findQuery, ['FRIEND_TOURNAMENT']);
        ['boost-id-1', 'boost-id-2'].map((boostId) => expect(queryStub).to.have.been.calledWithExactly(selectQuery, [boostId]));
        expect(updateStub).to.have.been.calledOnceWithExactly(updateQuery, ['boost-id-1']);
    });

    it('Expires boosts', async () => {
        const firstUpdateQuery = 'update boost_data.boost set active = $1 where active = true and end_time < current_timestamp returning boost_id';

        updateStub.onFirstCall().resolves({
            'rows': [
                { 'boost_id': 'boost-1' },
                { 'boost_id': 'boost-2' },
                { 'boost_id': 'boost-3' }
            ],
            rowCount: 3
        });

        const resultOfUpdate = await rds.expireBoostsPastEndTime();
        
        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal(['boost-1', 'boost-2', 'boost-3']);
        expect(updateStub).to.have.been.calledOnceWithExactly(firstUpdateQuery, [false]);
    });

    it('Boost culling exits where no boost found for update', async () => {
        const updateQuery = 'update boost_data.boost set active = $1 where active = true and end_time < current_timestamp returning boost_id';
        updateStub.onFirstCall().resolves({ rows: [], rowCount: 0 });

        const resultOfUpdate = await rds.expireBoostsPastEndTime();
       
        expect(resultOfUpdate).to.exist;
        expect(resultOfUpdate).to.deep.equal([]);
        expect(updateStub).to.to.have.been.calledOnceWithExactly(updateQuery, [false]);
    });

    it('Expires accounts past boost', async () => {
        // note: we do not expire CREATED, because those might be ML still (in practice, would be excluded anyway by expiry time 
        // not null, but better to do so here anyway)
        const updateQuery = `update boost_data.boost_account_status set boost_status = $1 where ` +
            `expiry_time is not null and expiry_time < current_timestamp and boost_status in ($2, $3, $4) ` +
            `returning boost_id, account_id`;
        
        updateStub.onFirstCall().resolves({ rows: [
            { 'boost_id': 'boost-1', 'account_id': 'account-1' }, { 'boost_id': 'boost-1', 'account_id': 'account-2' }, { 'boost_id': 'boost-2', 'account_id': 'account-1' } 
        ]});
        
        const resultOfCall = await rds.flipBoostStatusPastExpiry();

        expect(resultOfCall).to.deep.equal(
            [{ boostId: 'boost-1', accountId: 'account-1' }, { boostId: 'boost-1', accountId: 'account-2' }, { boostId: 'boost-2', accountId: 'account-1' }]
        );

        const expectedValues = ['EXPIRED', 'OFFERED', 'UNLOCKED', 'PENDING'];
        expect(updateStub).to.have.been.calledOnceWithExactly(updateQuery, expectedValues);
    });

    it('Gracefully handles no expiries', async () => {
        // query etc is above
        updateStub.onFirstCall().resolves({ rows: [] });
        const resultOfCall = await rds.flipBoostStatusPastExpiry();
        expect(resultOfCall).to.deep.equal([]);
    });
});
