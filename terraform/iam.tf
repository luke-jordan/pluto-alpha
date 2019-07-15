resource "aws_iam_policy" "dynamo_table_ClientFloatTable_access" {
  name        = "ClientFloatTable_access_${terraform.workspace}"
  path        = "/"

  policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "AccessClientFloatTable",
            "Effect": "Allow",
            "Action": [
                "dynamodb:*"
            ],
            "Resource": "arn:aws:dynamodb:${var.aws_default_region["${terraform.workspace}"]}:*:table/ClientFloatTable"
        }
    ]
}
EOF
}

resource "aws_iam_policy" "migration_script_s3_access" {
  name        = "migration_script_s3_access_${terraform.workspace}"
  path        = "/"

  policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "MigrationScriptAccess",
            "Effect": "Allow",
            "Action": [
                "s3:*"
            ],
            "Resource": "arn:aws:s3:::jupiter.db.migration.scripts/${terraform.workspace}/*"
        }
    ]
}
EOF
}

resource "aws_iam_policy" "dynamo_table_UserProfileTableRW_access" {
  name        = "UserProfileTable_access_${terraform.workspace}"
  path        = "/"

  policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "AccessUserProfileTable",
            "Effect": "Allow",
            "Action": [
                "dynamodb:PutItem",
                "dynamodb:DeleteItem",
                "dynamodb:GetItem",
                "dynamodb:Query",
                "dynamodb:UpdateItem"
            ],
            "Resource": [
                "arn:aws:dynamodb:${var.aws_default_region["${terraform.workspace}"]}:*:table/UserProfileTable",
                "arn:aws:dynamodb:${var.aws_default_region["${terraform.workspace}"]}:*:table/UserNationalIdTable",
                "arn:aws:dynamodb:${var.aws_default_region["${terraform.workspace}"]}:*:table/UserPhoneTable",
                "arn:aws:dynamodb:${var.aws_default_region["${terraform.workspace}"]}:*:table/UserEmailTable"
            ]
        }
    ]
}
EOF
}

resource "aws_iam_policy" "dynamo_table_UserProfileTableRead_access" {
  name        = "UserProfileTable_access_${terraform.workspace}"
  path        = "/"

  policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "ReadAccessUserProfileTable",
            "Effect": "Allow",
            "Action": [
                "dynamodb:GetItem",
                "dynamodb:Query"
            ],
            "Resource": "arn:aws:dynamodb:${var.aws_default_region["${terraform.workspace}"]}:*:table/UserProfileTable"
        }
    ]
}
EOF
}

resource "aws_iam_policy" "dynamo_table_UserDetailsTablesRead_access" {
  name        = "UserDetailsQueryTables_access_${terraform.workspace}"
  path        = "/"

  policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "QueryUserDetailsTables",
            "Effect": "Allow",
            "Action": [
                "dynamodb:GetItem",
                "dynamodb:Query"
            ],
            "Resource": [
                "arn:aws:dynamodb:${var.aws_default_region["${terraform.workspace}"]}:*:table/UserNationalIdTable",
                "arn:aws:dynamodb:${var.aws_default_region["${terraform.workspace}"]}:*:table/UserPhoneTable",
                "arn:aws:dynamodb:${var.aws_default_region["${terraform.workspace}"]}:*:table/UserEmailTable"
            ]
        }
    ]
}
EOF
}
