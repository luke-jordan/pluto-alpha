const { expect } = require("chai");


describe('*** UNIT TEST BOOST READING ***', () => {

    it('Fetches boosts with dynamic audiences', async () => {
        // could also do this via an inner join, but subquery likely faster (this is background, but ripe for optimization later)
        const audienceTable = 'audience_data.audience';
        const expectedQuery = `select * from ${boostMainTable} where active = true and end_time > current_timestamp and ` +
            `boost_type != $1 and not ($2 = any(flags)) ` +
            `and audience_id in (select audience_id from ${audienceTable} where is_dynamic = true)`;
        
        queryStub.resolves([boostFromPersistence]);

        const resultOfFetch = await rds.fetchBoostsWithDynamicAudiences();
        expect(resultOfFetch).to.deep.equal([expectedBoostResult]);

        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, ['REFERRAL', 'FRIEND_TOURNAMENT']);
    });

    it('Fetches active boosts, non-referral, non-friend tournament', async () => {
        // possibly just use audience type GENERAL in here, but have not been consistent in using elsewhere, so likely awaits a refactor 
        const expectedQuery = `select * from ${boostMainTable} where active = true and end_time > current_timestamp and ` +
            `boost_type != $1 and not ($2 = any(flags))`;
        
        queryStub.resolves([boostFromPersistence]);

        const resultOfFetch = await rds.fetchActiveStandardBoosts();
        expect(resultOfFetch).to.deep.equal([expectedBoostResult]);

        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, ['REFERRAL', 'FRIEND_TOURNAMENT']);
    });

    it('Find accounts in audience (refreshed) but not boost', async () => {
        // as above, left join might also work, but this should be quite fast
        const expectedQuery = `select account_id from audience_data.audience_account_join where audience_id = $1 and active = true and ` +
            `account_id not in (select account_id from boost_data.boost_account_status where boost_id = $2)`;
        
        queryStub.resolves([{ 'account_id': 'account-1' }, { 'account_id': 'account-2' }]);
        const resultOfFetch = await rds.fetchNewAudienceMembers('boost-id', 'audience-id');
        expect(resultOfFetch).to.deep.equal(['account-1', 'account-2']);

        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, ['audience-id', 'boost-id']);
    });

    it('Fetches account ids for pooled rewards', async () => {
        const logType = 'BOOST_POOL_CONTRIBUTION';
        const selectQuery = `select distinct(account_id) from boost_data.boost_log where log_type = $1 and boost_id = $2`;
        queryStub.resolves([{ 'account_id': 'account-1' }, { 'account_id': 'account-2' }]);

        const result = await rds.findAccountsForPooledReward(testBoostId, logType);
        expect(result).to.deep.equal({ boostId: testBoostId, accountIds: ['account-1', 'account-2'] });

        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, [logType, testBoostId]);
    });

    it('Fetches user Ids for accounts', async () => {
        const testAccountIds = testHelper.createUUIDArray(2);
        const [firstUserId, secondUserId] = testHelper.createUUIDArray(2);
        const selectQuery = `select distinct(owner_user_id) from ${config.get('tables.accountLedger')} where ` +
            `account_id in ($1, $2)`;
        queryStub.resolves([{ 'owner_user_id': firstUserId }, { 'owner_user_id': secondUserId }]);

        const result = await rds.findUserIdsForAccounts(testAccountIds);

        expect(result).to.deep.equal([firstUserId, secondUserId]);
        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, testAccountIds);
    });

    it('Fetches friendship user ids', async () => {
        const testRelationshipIds = testHelper.createUUIDArray(2);
        const [firstUserId, secondUserId, thirdUserId] = testHelper.createUUIDArray(3);
        const selectQuery = `select initiated_user_id, accepted_user_id from ${config.get('tables.friendshipTable')} where ` +
            `relationship_status = $1 and relationship_id in ($2, $3)`;
        queryStub.resolves([
            { 'initiated_user_id': firstUserId, 'accepted_user_id': secondUserId },
            { 'initiated_user_id': thirdUserId, 'accepted_user_id': firstUserId }
        ]);

        const result = await rds.fetchUserIdsForRelationships(testRelationshipIds);

        expect(result).to.deep.equal([
            { initiatedUserId: firstUserId, acceptedUserId: secondUserId },
            { initiatedUserId: thirdUserId, acceptedUserId: firstUserId }
        ]);
        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, ['ACTIVE', ...testRelationshipIds]);
    });

    it('Fetches boost account join, single', async () => {
        const expectedQuery = `select * from boost_data.boost_account_status where boost_id = $1 and account_id = $2`;
        queryStub.resolves([{ 'boost_id': 'some-id', 'boost_status': 'UNLOCKED' }]);

        const result = await rds.fetchCurrentBoostStatus('some-id', 'some-account');
        expect(result).to.deep.equal({ boostId: 'some-id', boostStatus: 'UNLOCKED' });

        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, ['some-id', 'some-account']);
    });

    it('Handles empty boost account join', async () => {
        const expectedQuery = `select * from boost_data.boost_account_status where boost_id = $1 and account_id = $2`;
        queryStub.resolves([]);

        const result = await rds.fetchCurrentBoostStatus('some-id', 'some-account');
        expect(result).to.be.null;

        expect(queryStub).to.have.been.calledOnceWithExactly(expectedQuery, ['some-id', 'some-account']);
    });

})