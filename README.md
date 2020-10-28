<!--lint disable no-literal-urls-->
<p align="center">
  <!-- <a href="https://jupitersave.com/"> -->
    <img alt="Jupiter Savings" src="logo.svg" width="400" height="100"/>
  </a>
</p>

<p align="center">Jupiter rewards you for saving.</p>

<!-- ![Alt text](logo.svg?raw=true "Jupiter Logo") -->

## Table of Contents

* [Quick Start](#quick-start)
* [Project Structure](#project-structure)
* [Integrations](#integrations)
* [Contributing to Jupiter](#contributing-to-jupiter)
  * [Policies and Local Development](#policies-and-local-development)
  * [Generating Documentation From Docstrings](#generating-documentation-from-docstrings)


## Quick Start
This quickstart covers the basics of installing packages, linking modules, and running tests.

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

## Project Structure

The core codebase consists of the following directories:
- `functions`
- `modules`
- `terraform`

The contents of these directories are described below.

### Functions
All core APIs may be found in the `functions` directory. These APIs are listed below with a brief description of their operations.

- `admin-api` (API for admin interface. Functions include float, saving-heat, and user management)
- `audience-selection` (API for boost audience selection)
- `boost-api` (API for core boost operations, e.g., boost creation, automation and redemption. Also includes boost admin functions)
- `float-api` (API for float management, handles float accrual, allocation and capitalization)
- `friend-api` (API for friends feature, contains functions for friend management, e.g., friend requests and alerts)
- `referral-api` (API for referral code management, includes functions for redeeming referral based boosts)
- `snippet-api` (API for snippet feature, contains functions for snippet management)
- `third-parties` (This directory contains functions that handle third party API integrations)
- `user-activity-api` (API for user interface, e.g., functions for fetching user balance, history, pending transactions, savings heat, and locked saves)
- `user-existence-api` (Contains functions for validating user existence)
- `user-maessaging-api` (API for user message management, i.e., system notifications to user. Includes functions for message creation, selection and triggering)

The `functions` directory also includes a `db-migration` and `warmup` folder. `db-migration` contains functions for Postgresql database migrations. `warmup` contains functions responsible for keeping connections to core lambdas warm (fast).

### Modules
The `modules` directory contains utility functions used in all APIs within the `functions` directory. These include persistence functions for database management, event/response wrappers, and dispatch functions for event publishing and system notifications (SMS and email). The contents of the `modules` directory are briefly described below.

- `dynamo-common` (Contains essential functions that make it easier to work with dynamo-db)
- `rds-common` (Core functions used in working with AWS RDS ())
- `publish-common` (Dispatch functions for event publishing and system notifications)
- `ops-util-common` (Core utilities used throughout the codebase, e.g., event/response wrappers, currency unit converters, event parsers, and common validators)

### Terraform and CircleCI
The `terraform` directory contains all Terraform configuration files for resource allocations and deployments.

After applying terraform:
`terraform workspace select staging`
`terraform apply -var 'deploy_code_commit_hash=058c7f3729dd375e0983e09b276a2a3caa0df3dd' -var 'aws_access_key=****************' -var 'aws_secret_access_key=***********' -var 'db_user=aaabbbccc' -var 'db_password=aaabbbccc'`

API requests can be sent to :
`curl -vvv -X POST  https://[staging|master].jupiterapp.net/verify-jwt`


With regards to CircleCI there is a hidden `.circleci` folder in the project's root directory which contains a `config.yml` used in specifying how each commit to the repository should be linted, tested, and deployed to staging. When creating new Jupiter methods or APIs make sure that they are included in the `config.yml` file where necessary. The `.circleci` folder also contains helper files used in merging packages, installing dependencies, as well as testing and linting. These files help ensure the CI process runs as quickly and efficiently as possible. **Understanding these configuration files is essential.**


## Integrations

The APIs listed above also take advantage of external APIs that provide the following services:

1. Authentication ([Jupiter Auth Service](#jupiter-auth-integrations))
2. KYC Verifications ([pbVerify Credit Bureau](#pbverify-integrations))
3. User Account Management ([Finworks](#finworks-integrations))
4. Message Dispatching ([SendGrid](#sendgrid-integrations))
5. Payment URLs ([Ozow](#ozow-integrations))

### Jupiter Auth Integrations

This API provides authentication services for user registration, user login (token and one-time-password generation) as well as services for user profile and password management. Naturally, this is the most extensive integration of an external API. Essential services provided by Jupiter Auth are listed below:

* User registration
* User login
* Event authorization
* Admin management (seeding initial admin user)
* Garbage collection (for the cleanup of incomplete profiles, i.e., aborted registrations)
* OTP generation
* Password management (password creation, encryption, persistence, and updates)
* Event logging
* Security questions
* User profile management (profile creation, updates, and validations)

### pbVerify Integrations

The pbVerify Credit Bureau API provides Know-Your-User services such as user identity validation and bank verifications.

### Finworks Integrations

The Finworks API provides services for managing funds within a users account. It is used to handle user deposits, withdrawals, and get the market value of a user account.

### SendGrid Integrations

SendGrid provides functions for the robust handling of email dispatches.

### Ozow Integrations

Ozow's API is used to generate a secure url from which a user can make a deposit into their account.

## Contributing to Jupiter

### Policies and Local Development

The master branch is protected and will not accept pull requests from any branch aside from staging. 

The staging branch is not protected against pushes but will accept pull requests from development branches. Every PR to staging requires code review 
security and linting to all pass, as well as at least one code review. New branches should fork from the current staging branch. 
Pull requests should aim for 400-500 lines of code at a time to facilitate reviews. Larger PRs will require more reviews before acceptance.
It is mandatory that all developers use git-secrets as a safe-guard against credentials being commited to the repository. Installation and usage instructions may be found here https://github.com/awslabs/git-secrets .

### Generating Documentation From Docstrings

Each api in the `functions` directory includes a README file created from the docstrings within the code. To regenenate the README after making changes to the code and related docstrings, install jsdoc2md using the command

```
$ npm install -g jsdoc-to-markdown
$ cd <target directory>
$ jsdoc2md *.js > README.md
```
This will generate a README from all the Javascript docstrings in the current working directory.



