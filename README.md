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



## Terraform
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

# Project Structure

The core codebase consists of the following directories:
- `functions`
- `modules`
- `terraform`

The contents of these directories are described below.

## Functions
All core APIs may be found in the `functions` directory. These APIs are listed below, with a brief description of their core operations.

- `admin api` (API for admin interface, all admin operations can be found here)
- `audience selection` (API for boost audience selection)
- `boost api` (API for core boost operations, e.g., boost creation, automation and redemption. Also includes boost admin functions)
- `float api` (API for float management, handles float accruals, allocations and capitalizations)
- `friend api` (API for friends feature, contains functions for friend management, e.g., friend requests and alerts)
- `referral api` (API for referral code management, includes functions for redeeming referral based boosts)
- `snippet api` (API for snippet feature, contains functions for snippet management)
- `third parties` (This directory contains functions that handle third party API integrations)
- `user activity api` (API for user interface, e.g., functions for fetching user balance, history, pending transactions, savings heat, locking saves and general user events)
- `user existence api` (Contains functions for validating user existence)
- `user maessaging api` (API for user message management, i.e., system notifications to user. Includes functions for message creation, selection and triggering)

The `functions` directory also includes a `db-migration` and `warmup` folder. `db-migration` contains functions for Postgresql database migrations. `warmup` contains functions responsible for keeping connections to core lambdas warm (fast).

## Modules
The `modules` directory contains utility functions used in all APIs within the `functions` directory. These include persistence functions for database management, event/response wrappers for ensuring common structure in API events and responses, and dispatch functions for event publishing and system notifications (SMS and email). The contents of the `modules` directory are briefly described below.

- `dynamo-common` (Contains essential functions that make it easier to work with dynamo-db)
- `rds-common` (Core functions used in working with RDS)
- `publish-common` (Dispatch functions for event publishing and system notifications)
- `ops-util-common` (Core utilities used throughout the codebase, e.g., event/response wrappers, currency unit converters, event parsers, and common validators)

## Terraform
The `terraform` directory contains all terraform configuration files for resource allocations and deployments.
