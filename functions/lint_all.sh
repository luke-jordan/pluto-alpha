#! /bin/bash
set -e

echo "Running linting on functions"
cd user-existence-api; npm run-script lint
cd ../user-activity-api; npm run-script lint
cd ../float-api; npm run-script lint
cd ../boost-api; npm run-script lint
cd ../user-messaging-api; npm run-script lint
cd ../audience-selection; npm run-script lint
cd ../snippet-api; npm run-script lint
cd ../admin-api; npm run-script lint
cd ../referral-api; npm run-script lint
cd ../third-parties; npm run-script lint
cd ../db-migration; npm run-script lint
cd ..

echo "Running module tests"
cd ../modules/dynamo-common; npm run-script lint
cd ../rds-common; npm run-script lint
cd ../publish-common; npm run-script lint
