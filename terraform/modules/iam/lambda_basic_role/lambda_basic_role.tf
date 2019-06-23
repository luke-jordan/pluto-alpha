variable "aws_iam_role_name" {
  type = "string"
}
resource "aws_iam_role" "lambda-basic-role" {
  name = "${var.aws_iam_role_name}"

  assume_role_policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": "sts:AssumeRole",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Effect": "Allow",
      "Sid": ""
    }
  ]
}
EOF
}