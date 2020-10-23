# POLICIES AND LOCAL DEVELOPMENT

The master branch is protected and will not accept pull requests from any branch aside from staging. 

The staging branch is not protected against pushes but will accept pull requests from development branches. Every PR to staging requires code review 
security and linting to all pass, as well as at least one code review. New branches should fork from the current staging branch. 
Pull requests should aim for 400-500 lines of code at a time to facilitate reviews. Larger PRs will require more reviews before acceptance.
It is mandatory that all developers use git-secrets as a safe-guard against credentials being commited to the repository. Installation and usage instructions may be found here https://github.com/awslabs/git-secrets .

## STEP 1: Quickstart => Install packages, link modules and run tests
Please install Nodejs if you don't have it installed: <https://nodejs.org/en/>.

By the end of this step, you'll be able to run tests for a function or module.
The generic steps involve installing node packages, linking dependent modules and running the tests.
In this example, we'll be using the `functions/float-api` folder as it covers a good use case.
Follow the steps below:


1. Navigate to the root directory of the `pluto-alpha` project. 

2. Install the node packages in the common modules (in this instance: modules `float-api` depends on) by running the command:
 `cd ./modules/rds-common && npm install && sudo npm link && cd ../dynamo-common && npm install && sudo npm link`.
The `npm link` command establishes a linking references for the common modules in step 1, in `./modules/rds-common` and then `./modules/dynamo-common`.
N/B: The above command is contained in the file `link_common_modules.sh` for ease of rerunning when needed.

3. Navigate to the working directory of the dependent function (in this case: `functions/float-api`). Run the command:
`cd ../../functions/float-api`

4. Run `npm install` to install the node modules.
 
5. Link the common modules to `functions/float-api` by running the following command from the terminal:
 `npm link rds-common && npm link dynamo-common`. 
 
6. From the working directory of `functions/float-api`. Run tests with the following command:
`npm run test`

All the tests should be running successfully.



## TERRAFORM
After applying terraform:
`terraform workspace select staging`
`terraform apply -var 'deploy_code_commit_hash=058c7f3729dd375e0983e09b276a2a3caa0df3dd' -var 'aws_access_key=****************' -var 'aws_secret_access_key=***********' -var 'db_user=aaabbbccc' -var 'db_password=aaabbbccc'`

API requests can be sent to :
`curl -vvv -X POST  https://[staging|master].jupiterapp.net/verify-jwt`

## Generating Documentation From Docstrings

Each function directory includes a README file created from the docstrings within the code. To regenenate the README after making changes to the code and related docstrings, install jsdoc2md using the command

```
$ npm install --save-dev jsdoc-to-markdown
```
 then run
 ```
$ jsdoc2md *.js > README.md
```
to generate a README from all the docstrings in the directory. For more information see https://github.com/jsdoc2md/jsdoc-to-markdown

# Core APIs and Lambdas
Within the functions directory are lambda functions that constitute the following APIs
* Admin API
* Audience Selection 
* Boost API
* Float API
* Friend API
* Referral API
* Snippet API
* Third Party Related Lambdas
* User Activity API
* User Existence API
* User Messaging API

## Admin API Core Lambdas
---


<dl>
<dt><a href="#assembleClientFloatData">assembleClientFloatData(countriesAndClients, clientFloatItems)</a></dt>
<dd><p>Knits together a variety of data to assemble the float totals, names, etc., for the current clients &amp; floats</p>
</dd>
<dt><a href="#listClientsAndFloats">listClientsAndFloats(event)</a></dt>
<dd><p>The function fetches client float variables.</p>
</dd>
<dt><a href="#fetchClientFloatDetails">fetchClientFloatDetails()</a></dt>
<dd><p>Fetches the details on a client float, including, e.g., accrual rates, referral codes, also soon competitor rates
as well as float logs, which it scans for &#39;alerts&#39; (i.e., certain types of logs)</p>
</dd>
<dt><a href="#adjustClientFloat">adjustClientFloat()</a></dt>
<dd><p>Handles a variety of client-float edits, such as: (a) editing accrual rates and the like, (b) dealing with logs
Note: will be called from different endpoints but consolidating as single lambda</p>
</dd>
<dt><a href="#manageReferralCodes">manageReferralCodes()</a></dt>
<dd><p>Operations: CREATE, MODIFY, DEACTIVATE, LIST</p>
</dd>
<dt><a href="#writeLog">writeLog(event)</a></dt>
<dd><p>This function write a user log. If a binary file is included the file is uploaded to s3 and the path to
the file is stored in the user logs event context.</p>
</dd>
<dt><a href="#fetchLog">fetchLog(event)</a></dt>
<dd><p>This file fetches a user log. If the s3 file path of a binary file is found the file is retrieved and
return with the function ooutput.</p>
</dd>
<dt><a href="#uploadLogBinary">uploadLogBinary(event)</a></dt>
<dd><p>Uploads a log associated attachment. Returns the uploaded attachment&#39;s s3 key.</p>
</dd>
<dt><a href="#manageUser">manageUser()</a></dt>
<dd></dd>
<dt><a href="#fetchUserCounts">fetchUserCounts(event)</a></dt>
<dd><p>Gets the user counts for the front page, usign a mix of parameters. Leaving out a parameter will invoke a default</p>
</dd>
<dt><a href="#findUsers">findUsers(event)</a></dt>
<dd><p>Function for looking up a user and returning basic data about them</p>
</dd>
<dt><a href="#runRegularJobs">runRegularJobs()</a></dt>
<dd><p>Runs daily. Does several things:
(1) checks for accruals on each float &amp; then triggers the relevant job
(2) sends an email to the designated list with key stats for the day
(3) cleans up transaction ledger by setting old pending transactions to expired</p>
</dd>
</dl>


## Audience Selection Lambdas
---

<dl>
<dt><a href="#addTableAndClientId">addTableAndClientId(selection, clientId, tableKey)</a></dt>
<dd><p>This takes a selection object and does a final top to it, i.e., adds a client ID and a table name
Note : some tables do not have client IDs so need to not add (i.e., boost)
Note : in some cases we have converted to aggregate entities, which means we need to adjust this</p>
</dd>
<dt><a href="#handleInboundRequest">handleInboundRequest(event)</a></dt>
<dd><p>Primary method. Can be called directly via invoke or as admin from form. Event or body require the following:</p>
</dd>
<dt><a href="#executeColumnConditions">executeColumnConditions(persistenceParams)</a></dt>
<dd><p>Called right at the end when the column conditions are all in good oder. For selection query only, just past the object.
If the audience is to be persisted, set persistSelection to true and pass these parameters:</p>
</dd>
</dl>

## Boost API Lambdas
---

<dl>
<dt><a href="#listBoosts">listBoosts(event)</a></dt>
<dd><p>Lists boosts, with optional param to restrict to currently running ones.</p>
</dd>
<dt><a href="#updateInstruction">updateInstruction(event)</a></dt>
<dd><p>Flexible method/endpoint to update a boost, more or less any parameter</p>
</dd>
<dt><a href="#createMsgInstructionFromDefinition">createMsgInstructionFromDefinition(boostParams, messageDefinition, gameParams)</a></dt>
<dd><p>Assembles instruction payloads from messages created by admin user while they create the boost.
This depends on a message definition of the form:
{ presentationType, isMessageSequence, msgTemplates }
msgTemplates must be a dict with keys as boost statuses and objects a standard message template (see messages docs for format)</p>
</dd>
<dt><a href="#createBoost">createBoost(event)</a></dt>
<dd><p>The primary method here. Creates a boost and sets various other methods into action
Note, there are three ways boosts can have their messages assigned:
(1) Include an explicit set of redemption message instructions (&#39;redemptionMsgInstructions&#39;)
(2) Include a set of message instruction flags (i.e., ways to find defaults), as a dict with top-level key being the status (&#39;messageInstructionFlags&#39;)
(3) Include the message definitions in messages to create (&#39;messagesToCreate&#39;)</p>
<p>Note (1): There is a distinction between (i) a message that is presented in a linked sequence, as in a game, and (ii) multiple messages
that are independent of each other, e.g., a push notification and an in-app card. The first case comes in a single message definition
because the messages must be sent to the app together; the second comes in multiple definitions.</p>
<p>Note (2): If multiple of the types above are passed, (3) will override the others (as it is called last)
Also note that if none are provided the boost will have no message and just hang in the ether</p>
<p>Note (3) on rewardParameters: where provided the following properties are expected:
rewardType, required. Valid values are &#39;SIMPLE&#39;, &#39;RANDOM&#39;, and &#39;POOLED&#39;. If reward rewardType is &#39;SIMPLE&#39; no other properties are required.
If the rewardType is &#39;RANDOM&#39; the following properties may be provided: distribution (default is UNIFORM), targetMean (default is use boostAmount),
significantFigures (optional - rounding amount, if not specified, amounts will be rounded to whole numbers), and realizedRewardModuloZeroTarget (optional - when provided only
amounts that leave no remainder when divided by this number will be used as rewards).
If rewardType is &#39;POOLED&#39; the following properties must be provided: poolContributionPerUser (a sub-dict, with amount, unit, currency).
percentPoolAsReward (specifies how much of the pool gets awarded as the reward amount), additionalBonusToPool (defines how much the overall Jupiter bonus pool will
contribute to the reward, also a sub-dict with usual amount-unit-etc format).</p>
</dd>
<dt><a href="#createBoostWrapper">createBoostWrapper(event)</a></dt>
<dd><p>Wrapper method for API gateway, handling authorization via the header, extracting body, etc.</p>
</dd>
<dt><a href="#handleBatchOfQueuedEvents">handleBatchOfQueuedEvents(sqsBatch)</a></dt>
<dd><p>Generic handler for any boost relevant response (add cash, solve game, etc)
Note: at present, since we handle a relatively limited range of events, this gets directly invoked,
though in future we may put it onto the same SNS topic as message process and event handler</p>
</dd>
<dt><a href="#handleExpiredBoost">handleExpiredBoost(boostId)</a></dt>
<dd><p>Not called by the Lambda, but is the heart of things, so exposed for testing</p>
</dd>
<dt><a href="#checkForBoostsToExpire">checkForBoostsToExpire(event)</a></dt>
<dd><p>This function checks for boosts and tournaments to be expired. If a boost is to be expired the function
asserts what time type of boost it is. If it is a game or random award then the winners are awarded the boost amounts
and the boost is discarded/expired.</p>
</dd>
<dt><a href="#listUserBoosts">listUserBoosts()</a></dt>
<dd><p>This functions fetches a users boosts.</p>
</dd>
<dt><a href="#listChangedBoosts">listChangedBoosts(event)</a></dt>
<dd><p>This method decides what to notify a user of</p>
</dd>
<dt><a href="#fetchBoostDetails">fetchBoostDetails()</a></dt>
<dd><p>This method provides the details of a boost, including (if a friend tournament), the score logs</p>
</dd>
<dt><a href="#processMlBoosts">processMlBoosts(boostId)</a></dt>
<dd><p>A scheduled job that pulls and processes active ML boosts.</p>
</dd>
<dt><a href="#calculateBoostAmount">calculateBoostAmount()</a></dt>
<dd><p>Used also in expiry handler to set the boost amount once this is done, so exporting</p>
</dd>
<dt><a href="#handleTransferToBonusPool">handleTransferToBonusPool()</a></dt>
<dd><p>USED ONLY FOR FRIEND TOURNAMENTS WHERE USERS EXPLICITLY FUND THE BOOST</p>
</dd>
<dt><a href="#redeemOrRevokeBoosts">redeemOrRevokeBoosts()</a></dt>
<dd><p>Complicated thing in here is affectedAccountsDict. It stores, for each boost, the accounts whose statusses have been changed. Format:
The affectedAccountsDict has as its top level keys the boost IDs for the boosts that have been triggered.
The value of each entry is a map, referred to as accountUserMap, in which the keys are the accountIds that have been triggered,
and the value is the final dict, containing the userId of the owner of the account, and the <em>current</em> (not the triggered) status
(to clarify the last -- if the user is in status PENDING, and has just fulfilled the conditions for REDEEMED, the status in the dict
will be PENDING)</p>
</dd>
<dt><a href="#handleAllScheduledTasks">handleAllScheduledTasks(event)</a></dt>
<dd><p>Helper method that allows calling the others. Exporting the others for simpler testing and may at some point put on their own lambdas</p>
</dd>
<dt><a href="#processUserBoostResponse">processUserBoostResponse(event)</a></dt>
<dd></dd>
<dt><a href="#cacheGameResponse">cacheGameResponse(event)</a></dt>
<dd><p>This function handles game session cache creation and user score updates to the cache.</p>
</dd>
<dt><a href="#checkForHangingGame">checkForHangingGame()</a></dt>
<dd><p>This function checks for hanging expired games, i.e., games that remain in cache after their gameEndTime
has been exceeded. If any are found they are removed from cache.</p>
</dd>
<dt><a href="#fetchOrValidateFinalScore">fetchOrValidateFinalScore(sessionId, finalScore)</a></dt>
<dd><p>This function validates a users final score or fetches it from cache.</p>
</dd>
</dl>

## Float API Lambdas
---

<dl>
<dt><a href="#accrue">accrue(event)</a></dt>
<dd><p>The core function. Receives an instruction that interest (or other return) has been accrued, increases the balance recorded,
and then allocates the amounts to the client&#39;s bonus and company shares, and thereafter allocates to all accounts with 
contributions to the float in the past. Expects the following parameters in the lambda invocation or body of the post</p>
</dd>
<dt><a href="#allocate">allocate(event)</a></dt>
<dd><p>Divides up all the allocations, records them, and does a massive batch insert as a single TX
If one allocation does not succeed, all need to be redone, otherwise the calculations will go (way) off
Note: this is generally the heart of the engine, and will require constant and continuous optimization, it will be 
triggered whenever another job detects unallocated amounts in the float.</p>
</dd>
<dt><a href="#calculateShare">calculateShare(totalPool, shareInPercent, roundEvenUp)</a></dt>
<dd><p>Utility method to reliably calculate a share, using DecimalLight and a lot of tests to enforce robustness and avoid 
possible floating point issues. It is exported as (1) it might graduate to its own lambda, and (2) although small
it is the kind of thing that can crash spaceships into planets so it needs to be tested very very thoroughly on its own</p>
</dd>
<dt><a href="#sumUpBalances">sumUpBalances(accountBalances)</a></dt>
<dd><p>A utility method to sum up all the account balances</p>
</dd>
<dt><a href="#apportion">apportion(amountToDivide, accountTotals, appendExcess)</a></dt>
<dd><p>Core calculation method. Apportions an amount (i.e., the unallocated amount of a float) among an arbitrary length list of accounts
in proportion to each of those account&#39;s balances. Note that the share of the total allocated to a specific account is not that account&#39;s
balance divided by the total to be allocated, but that account&#39;s balance divided by the total balance of all the passed accounts.
Returns a new map with (again) the account ids as keys, but the values being the amount apportioned to the account from the total</p>
</dd>
<dt><a href="#preview">preview()</a></dt>
<dd><p>Allows admin to review the operation before committing it. Conducts all the calculations and then returns the top level
results plus a sample of the transactions</p>
</dd>
<dt><a href="#handleInstruction">handleInstruction(instruction)</a></dt>
<dd><p>Method in need of some cleaning up / refactoring to simplify cases, but which is purposefully highly flexible. Cases:
Allocations from bonus pool to users; allocation from client pool to users; allocation from company pool to users.
Allocations to float itself (i.e., addition to float total balance), allocations from unallocated float balance to
company pool / bonus pool (by admin, e.g., after a transfer of company capital into float to fund bonus pool), and finally
from float itself (unallocated balance) to all users (i.e., distributing to them)</p>
<p>NOTE: does not allow for, e.g., doing a distribution to users directly from client account -- would get messy, and will be
extremely rare. Instead, admin user would do a negative allocation to company, which would free up spare float, and that 
would then be distributed to users.</p>
<p>NOTE 2: assumes (given the cases above, that this is &#39;settled&#39;, unless told otherwise)</p>
</dd>
<dt><a href="#floatTransfer">floatTransfer(instructions)</a></dt>
<dd><p>This function handles float transfer instructions. Event properties are described below.</p>
</dd>
</dl>


## Friend API Lambdas
---

<dl>
<dt><a href="#fetchFriendAlert">fetchFriendAlert()</a></dt>
<dd><p>Determines if there is something new to show to the user. If so, sends it back</p>
</dd>
<dt><a href="#markAlertsViewed">markAlertsViewed()</a></dt>
<dd><p>Adjusts a log (or set of them) to mark that the user has been fully alerted to them.</p>
</dd>
<dt><a href="#directAlertRequest">directAlertRequest()</a></dt>
<dd><p>As with request, this helps us manage API and lambda proliferation</p>
</dd>
<dt><a href="#appendSavingHeatToProfiles">appendSavingHeatToProfiles(profiles, userAccountMap)</a></dt>
<dd><p>This function appends a savings heat score to each profile. The savings heat is either fetched from cache or
calculated by the savings heat lambda.</p>
</dd>
<dt><a href="#fetchOwnSavingHeat">fetchOwnSavingHeat(systemWideUserId)</a></dt>
<dd><p>The function fetches the user profile and saving heat for the calling user. It differs from the
appendSavingHeatToProfiles process in that it does not seek friendships</p>
</dd>
<dt><a href="#obtainFriends">obtainFriends(event)</a></dt>
<dd><p>This functions accepts a users system id and returns the user&#39;s friends.</p>
</dd>
<dt><a href="#deactivateFriendship">deactivateFriendship(event)</a></dt>
<dd><p>This functions deactivates a friendship.</p>
</dd>
<dt><a href="#addFriendshipRequest">addFriendshipRequest(event)</a></dt>
<dd><p>This function persists a new friendship request.</p>
</dd>
<dt><a href="#initiateRequestFromReferralCode">initiateRequestFromReferralCode(event)</a></dt>
<dd><p>This will be used as a direct invocation. It just takes a referral code, finds the user that the code belongs to,
and then either create or stitch up a friend request to the new user</p>
</dd>
<dt><a href="#connectFriendshipRequest">connectFriendshipRequest(event, systemWideUserId, requestCode)</a></dt>
<dd><p>This function completes a previously ambigious friend request, where a friend was requested using a contact detail not
associated with any system user id. This function is called once the target user has confirmed they are are indeed the target for the
friendship. It accepts a request code (to identify the request) and the target users system id. The friendship request is
sought and the user id is added to its targetUserId field.</p>
</dd>
<dt><a href="#findFriendRequestsForUser">findFriendRequestsForUser()</a></dt>
<dd><p>This function returns an array of friend requests a user has not yet accepted (or ignored). Friend requests are
extracted for the system id in the request context.</p>
</dd>
<dt><a href="#acceptFriendshipRequest">acceptFriendshipRequest(event)</a></dt>
<dd><p>This function persists a new friendship. Triggered by a method that also flips the friend request to approved, but may also be called directly.</p>
</dd>
<dt><a href="#ignoreFriendshipRequest">ignoreFriendshipRequest(event)</a></dt>
<dd><p>todo : convert to taking request ID friend request received by a user. The difference between this function and the 
deactivateFriendship function is that this function ignores friendships that were never accepted.</p>
</dd>
<dt><a href="#cancelFriendshipRequest">cancelFriendshipRequest()</a></dt>
<dd><p>For when someone sent the request but now wants it gone. Unlike above, this cancels a specific request</p>
</dd>
<dt><a href="#directRequestManagement">directRequestManagement()</a></dt>
<dd><p>This just directs friendship-request management, on the lines of the audience management API, to avoid excessive lambda
and API GW resource proliferation. Note: try-catch robustness is inside the methods, so not duplicating</p>
</dd>
</dl>

## Referral API Lambdas
---

<dl>
<dt><a href="#defineReferralContext">defineReferralContext(params)</a></dt>
<dd><p>Sets the referral context, itself used for things like boosts based on the code
NOTE : on reflection, we are <em>not</em> normalizing this so that client-float referral details are pulled from its tables on each
use, because that would impose a trade-off between updating referral-boost details for future users and having to communicate
it to existing users. As it is, future users can have boost from their referral code adjusted, while prior ones do not</p>
</dd>
<dt><a href="#status">status(event)</a></dt>
<dd><p>Method to find out at present if referral codes are required for the country, and/or obtain a default</p>
</dd>
<dt><a href="#create">create(event)</a></dt>
<dd></dd>
<dt><a href="#verify">verify(event)</a></dt>
<dd><p>This function verifies a referral code.</p>
</dd>
<dt><a href="#modify">modify()</a></dt>
<dd><p>This function modifies a referral code, either deactivating it or updating certain properties. Only called directly so no wrapping.</p>
</dd>
</dl>

## Snippet API Lambdas
---

<dl>
<dt><a href="#listSnippets">listSnippets(event)</a></dt>
<dd><p>This function list all active snippets for an admin user (also includes how many times each
snippet has been created for users).</p>
</dd>
<dt><a href="#viewSnippet">viewSnippet(event)</a></dt>
<dd><p>This function fetches major snippet details (sucj as title, text, the number of users it has been created for
how many times the snippet has been fetched and viewed, etc) for a defined snippet for an admin user.</p>
</dd>
<dt><a href="#readSnippets">readSnippets()</a></dt>
<dd><p>Generic handler to reduce need for lambda proliferation</p>
</dd>
<dt><a href="#createSnippet">createSnippet(event)</a></dt>
<dd><p>This function creates a new snippet.</p>
</dd>
<dt><a href="#updateSnippet">updateSnippet(event)</a></dt>
<dd><p>This function updates a snippets properties. The only property updates allowed by the this function are
the snippets text, title, active status, and priority.</p>
</dd>
<dt><a href="#addUserToPreviewList">addUserToPreviewList(event)</a></dt>
<dd><p>Adds a new preview user, i.e a user who may preview snippets (to make snippets available for
preview set the value of the snippets preview_mode property to true).</p>
</dd>
<dt><a href="#removeUserFromPreviewList">removeUserFromPreviewList(event)</a></dt>
<dd><p>Removes a preview user. Users put through this process will no longer have access to snippets
in preview mode.</p>
</dd>
<dt><a href="#updateMultipleSnippetsForUser">updateMultipleSnippetsForUser(event)</a></dt>
<dd><p>Updates a snippets status to FETCHED or VIEWED.</p>
</dd>
<dt><a href="#handleSnippetStatusUpdates">handleSnippetStatusUpdates(sqsEvent)</a></dt>
<dd><p>At the moment this can be called by SQS or by API GW. In time we will make API GW just dump into SQS, but later.</p>
</dd>
<dt><a href="#fetchSnippetsForUser">fetchSnippetsForUser(event)</a></dt>
<dd><p>This function fetches snippets to be displayed to a user. If there are snippets a user has not viewed
those are returned first, if not then previously viewed snippets are returned.</p>
</dd>
</dl>

## Third Party Related Lambdas
---
<dl>
<dt><a href="#initialize">initialize(event)</a></dt>
<dd><p>This function enables verifications on consumer bank account details to determine the state and 
validity of a South African bank account. The Following banks are supported ABSA; FNB; STANDARD, NEDBANK, CAPITEC. 
Processing Times – Although the service is available 24 x 7 x 365, records received after 17:00 on 
weekdays, will only be submitted on the next available working day. Records are only submitted for 
verification after 03:00 AM on normal weekdays. Responses may be available within 30 minutes, but it 
could take up to 3+ hours to receive responses from participating banks.
This function returns a job status and job id in its response.</p>
</dd>
<dt><a href="#checkStatus">checkStatus(event)</a></dt>
<dd><p>This function is used with the response from initialize(), you will receive a JobID in the result of
the verification which will be used to check on the status of the bank account verification.</p>
</dd>
<dt><a href="#addTransaction">addTransaction(sqsEvent)</a></dt>
<dd><p>Main entry point for regular operations</p>
</dd>
<dt><a href="#sendEmailMessages">sendEmailMessages(event)</a></dt>
<dd><p>This function sends pre-assembled emails, with the option of enclosing them in a wrapper from S3.</p>
</dd>
<dt><a href="#sendSmsMessage">sendSmsMessage()</a></dt>
<dd><p>This function sends sms messages via the Twilio api. It accepts a message and a phone number, assembles the request,
then hits up the Twilio API.</p>
</dd>
<dt><a href="#paymentUrlRequest">paymentUrlRequest(event)</a> ⇒ <code>object</code></dt>
<dd><p>This function gets a payment url from a third-party. Property descriptions for the event object accepted by this function are provided below. Further information may be found here <a href="https://ozow.com/integrations/">https://ozow.com/integrations/</a> .</p>
</dd>
<dt><a href="#statusCheck">statusCheck(event)</a> ⇒ <code>object</code></dt>
<dd><p>This method gets the tranaction status of a specified payment.</p>
</dd>
<dt><a href="#sendEmailsFromSource">sendEmailsFromSource(event)</a></dt>
<dd><p>This function sends emails to provided addresses. The email template is stored remotely and a locator key-bucket pair is required. In order to use substitutions in the email template
simply enclose the name of the template variable in double braces, then add the variable name and value to the destination objects temblateVariable object within the destinationArray.
For example, if your template was &#39;Greetings {{user}}.&#39; then in order to insert a different username per address, the destination object related to this template would look
like { emailAddress: user@email, templateVariables: { user: &#39;Vladimir&#39; } }. The user will then recieve an email: &#39;Greetings Vladimir&#39;. Multiple substitutions are supported.
This format also applies the below sendEmails function.</p>
</dd>
<dt><a href="#sendEmails">sendEmails(event)</a></dt>
<dd><p>This function sends emails to provided addresses.</p>
</dd>
</dl>

## User Activity API Lambdas
---

<dl>
<dt><a href="#balance">balance(event)</a></dt>
<dd><p>This function fetches account balances and projections.</p>
</dd>
<dt><a href="#balanceWrapper">balanceWrapper(event)</a></dt>
<dd><p>This is a convenience method exposed to allow for simple JWT based get balance based on defaults
Here only the account holders system wide id is required as a parameter (which is passed in the events requestContext.authorizer object).</p>
</dd>
<dt><a href="#handleUserEvent">handleUserEvent(eventBody)</a></dt>
<dd><p>This function handles successful account opening, saving, and withdrawal events. It is typically called by SNS. The following properties are expected in the SNS message:</p>
</dd>
<dt><a href="#handleBatchOfQueuedEvents">handleBatchOfQueuedEvents(sqsEvent)</a></dt>
<dd><p>This function processes a batch of events from SQS</p>
</dd>
<dt><a href="#fetchUserHistory">fetchUserHistory(event)</a></dt>
<dd><p>Fetches user history which includes current balance, current months interest, prior transactions, and past major user events.</p>
</dd>
<dt><a href="#calculateSavingHeat">calculateSavingHeat(event)</a></dt>
<dd><p>This function calculates and caches a user&#39;s saving heat score. The score is based on their savings activity as well
as other factors such as number of saving buddies, etc. If an empty object is received, the function will calculate
and cache savings heat scores for all accounts.</p>
</dd>
<dt><a href="#initiatePendingSave">initiatePendingSave(accountId, savedAmount, savedCurrency, savedUnit, floatId, clientId)</a> ⇒ <code>object</code></dt>
<dd><p>Wrapper method, calls the above, after verifying the user owns the account, event params are:</p>
</dd>
<dt><a href="#checkPendingPayment">checkPendingPayment(transactionId)</a></dt>
<dd><p>Checks on the backend whether this payment is done</p>
</dd>
<dt><a href="#setWithdrawalBankAccount">setWithdrawalBankAccount(event)</a></dt>
<dd><p>Initiates a withdrawal by setting the bank account for it, which gets verified, and then we go from there</p>
</dd>
<dt><a href="#setWithdrawalAmount">setWithdrawalAmount(event)</a></dt>
<dd><p>Proceeds to next item, the withdrawal amount, where we create the pending transaction, and decide whether to make an offer</p>
</dd>
<dt><a href="#confirmWithdrawal">confirmWithdrawal(event)</a></dt>
<dd><p>This function confirms a withdrawal. However, it makes it only &quot;pending&quot;, until admin confirms the transfer is done.</p>
</dd>
</dl>

## User Existence API Lambdas
---
## Functions

<dl>
<dt><a href="#createAccount">createAccount(creationRequest)</a></dt>
<dd><p>Creates an account within the core ledgers for a user. Returns the persistence result of the transaction.</p>
</dd>
<dt><a href="#create">create(event)</a></dt>
<dd><p>This function serves as a wrapper around the createAccount handler, processing events from API Gateway.</p>
</dd>
</dl>

## User Messaging API Lambdas
---
<dl>
<dt><a href="#placeParamsInTemplate">placeParamsInTemplate(template, passedParameters)</a></dt>
<dd><p>NOTE: This is only for custom params supplied with the message-creation event. System defined params should be left alone.
This function assembles the selected template and inserts relevent data where required.
todo : make sure this handles subparams on standard params (e.g., total_interest::since etc)</p>
</dd>
<dt><a href="#processNonRecurringInstruction">processNonRecurringInstruction(instructionDetail)</a></dt>
<dd><p>This function accepts an instruction detail object containing an instruction id, the destination user id, and extra parameters.
It uses these details to retrieve the associated instruction from persistence, assemble the user message(s), and finally persists the assembled user message(s) to RDS.</p>
</dd>
<dt><a href="#createUserMessages">createUserMessages(event)</a></dt>
<dd><p>A wrapper for simple instruction processing, although can handle multiple at once
note: this is only called for once off or event driven messages )i.e., invokes the above)</p>
</dd>
<dt><a href="#createFromRecurringInstructions">createFromRecurringInstructions()</a></dt>
<dd><p>This runs on a scheduled job. It processes any recurring instructions that match the parameters.
Note : disabling the once off as at present that gets sent right away, and this is causing potential duplication</p>
</dd>
<dt><a href="#assembleMessage">assembleMessage(messageDetails)</a></dt>
<dd><p>This function assembles user messages into a persistable object. It accepts a messageDetails object as its only argument.</p>
</dd>
<dt><a href="#fetchAndFillInNextMessage">fetchAndFillInNextMessage(destinationUserId, withinFlowFromMsgId)</a></dt>
<dd><p>This function fetches and fills in the next message in a sequence of messages.</p>
</dd>
<dt><a href="#getNextMessageForUser">getNextMessageForUser(event)</a></dt>
<dd><p>Wrapper for the above, based on token, i.e., direct fetch</p>
</dd>
<dt><a href="#updateUserMessage">updateUserMessage(event)</a></dt>
<dd><p>Simple (ish) method for updating a message once it has been delivered, etc.</p>
</dd>
<dt><a href="#managePushToken">managePushToken(event)</a></dt>
<dd><p>This function inserts a push token object into RDS. It requires that the user calling this function also owns the token.
An evaluation of the requestContext is run prior to token manipulation. If request context evaluation fails access is forbidden.
Non standared propertied are ignored during the assembly of the persistable token object.</p>
</dd>
<dt><a href="#deletePushToken">deletePushToken(event)</a></dt>
<dd><p>This function accepts a token provider and its owners user id. It then searches for the associated persisted token object and deletes it from the 
database. As during insertion, only the tokens owner can execute this action. This is implemented through request context evaluation, where the userId
found within the requestContext object must much the value of the tokens owner user id.</p>
</dd>
<dt><a href="#sendOutboundMessages">sendOutboundMessages(params)</a></dt>
<dd><p>Primary method. Sends push messages and emails in parallel.</p>
</dd>
<dt><a href="#handleBatchUserEvents">handleBatchUserEvents()</a></dt>
<dd><p>Triggered on user events. This function handles batch SQS user events. It parses the event from 
SQS then sends an array of parsed event objects to createFromUserMessage.</p>
</dd>
<dt><a href="#validateMessageInstruction">validateMessageInstruction(instruction)</a></dt>
<dd><p>Enforces instruction rules and ensures the message instruction is valid before it is persisted.
First it asserts whether all required properties are present in the instruction object. If so, then
condtional required properties are asserted. These are properties that are only required under certain condtions.
For example, if the message instruction has a recurring presentation then a recurrance instruction is required to
describe how frequently the notification should recur. The object properties received by this function are described below:</p>
</dd>
<dt><a href="#createPersistableObject">createPersistableObject(instruction, creatingUserId)</a></dt>
<dd><p>todo : validate templates
This function takes the instruction passed by the caller, assigns it an instruction id, activates it,
and assigns default values where none are provided by the input object.</p>
</dd>
<dt><a href="#insertMessageInstruction">insertMessageInstruction(event)</a></dt>
<dd><p>This function accepts a new instruction, validates the instruction, then persists it. Depending on the instruction, either
the whole or a subset of properties described below may be provided as input. </p>
<p>Note on templates: They can construct linked series of messages for users, depending on the top-level key, which can be either
&quot;template&quot;, or &quot;sequence&quot;. If it template, then only one message is generated, if it is sequence, then multiple are, and are linked.
Template contains the following: at least one top-level key, DEFAULT. Other variants (e.g., for A/B testing), can be defined as 
other top-level keys (e.g., VARIANT_A or TREATMENT). Underneath that key comes the message definition proper, as follows:
{ title: &#39;title of the message&#39;, body: &#39;body of the message&#39;, display: { displayDict }, responseAction: { }, responseContext: { dict }} </p>
<p>If the top-level key is sequence, then an array should follow. The first message in the array must be the opening message, and will be 
marked as hasFollowingMessage. All the others will be marked as followsPriorMessage. Each element of the array will be identical to 
that for a single template, as above, but will also include the key, &quot;identifier&quot;. This will be used to construct the messageIdsDict
that will be sent with each of the messages, so that the app or any other consumers can follow the sequences. Note that it is important
to keep the two identifiers distinct here: one, embedded within the template, is an identifier within the sequence of messages, the other,
at top level, identifies across variants.</p>
</dd>
<dt><a href="#updateInstruction">updateInstruction(event)</a></dt>
<dd><p>This function can be used to update various aspects of a message. Note that if it 
deactivates the message instruction, that will stop all future notifications from message instruction,
and removes existing ones from the fetch queue.</p>
</dd>
<dt><a href="#listActiveMessages">listActiveMessages(event)</a></dt>
<dd><p>This function (which will only be available to users with the right roles/permissions) will list currently active messages,
i.e., those that are marked as active, and, optionally, those that still have messages unread by users</p>
</dd>
</dl>

