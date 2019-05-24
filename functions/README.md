# THE FUNCTIONS

This folder contains the Lambdas that relate to the general domain of user and float management. They are divided as follows:

## Float API (float-api)

Contains lambdas for managing client floats. By far the most important parts are those handling interest / returns accrual and
an apportionment among the float's different accounts.

## User Existence API (user-ex-api)

Handles the creation of accounts, from start to finish, as well as user profiles, .

## User Activity API (user-act-api)

Handles ongoing user transactions. Handles saving, withdrawing, querying for the balance (= sum of Txs) and projected balance,
obtaining the history (= records of Txs), and checking on open rewards.

# CREATING AND DEPLOYING

## Creation

To create a new lambda, use the provided script create-node-function. The script takes as its first argument the name of the 
overall API / collection of lambdas, and the second as the first lambda you wish to create, for example:

``./create-node-function.sh float-api accrue``

The creation script will create the requisite folder, copy in a template serverless.yml file, replace some of its values appropriately,
and run an npm init script as well as installing a standard set of packages. You can add further lambdas in the future by editing the serverless.yml file.

**Note**: If your lambda will depend on the RDS or DynamoDB wrapper modules, then you will need to link one or both of the modules
(the other side of the link should have been established when installing the environment, see the root folder README). To do so, just
run one or both of:

``npm link rds-common``
``npm link dynamo-common``

## Local deployment and updating

To deploy locally, first make sure that Localstack is running. Then execute:

``sls deploy --stage local``

Deployment to other stages is only possible through the CI, unless you set up a personal AWS sandbox and deploy to that using a dev stage.

For updating, the Localstack and serverless-localstack toolkit is still under development, so there is a peculiar bug on some machines that 
the cloudformation stack is not created although all the resources are. That means serverless will not properly update code if deploy is 
rerun (as would usually be the case). A simple script (see the sample in user-existence-api) will take care of updates in that case.

**Note**: The localstack docker container does not persist over launches at present, so deploy fresh each time you restart. The various
scripts in the root folder and the `notebooks` folder will assist this.
