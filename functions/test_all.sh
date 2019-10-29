#! /bin/bash
set -e

echo "Removing prior NYC output so properly mimics deploy"
find . -name ".nyc_output" -exec rm -r {} +

echo "Running tests and outputing coverage reports"
cd user-existence-api; npm test; npm run-script generate-coverage
cd ../user-activity-api; npm test; npm run-script generate-coverage
cd ../float-api; npm test; npm run-script generate-coverage
cd ../boost-api; npm test; npm run-script generate-coverage
cd ../user-messaging-api; npm test; npm run-script generate-coverage
cd ../user-messaging-api; npm test; npm run-script generate-coverage
cd ../third-parties; npm test; npm run-script generate-coverage
cd ..

echo "Running module tests"
cd ../modules/dynamo-common; npm test; npm run-script generate-coverage
cd ../rds-common; npm test; npm run-script generate-coverage
cd ../publish-common; npm test; npm run-script generate-coverage
