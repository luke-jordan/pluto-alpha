resource "aws_iam_policy" "dynamo_table_ClientFloatTable_access" {
  name        = "ClientFloatTable_access"
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
  name        = "migration_script_s3_access"
  path        = "/"

  policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "migration_script_s3_access",
            "Effect": "Allow",
            "Action": [
                "s3:*"
            ],
            "Resource": "arn:aws:s3:::jupiter.db.migration.scripts/${var.aws_default_region[terraform.workspace]}/*"
        }
    ]
}
EOF
}