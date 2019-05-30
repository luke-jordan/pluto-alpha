resource "aws_iam_user" "_web_app_deployer" {
  name = "_web_app_deployer"
  tags = {
    tag-key = "tag-value",
    Environment = "${var.app_name}-${var.environment}"
  }
}

resource "aws_iam_user_policy" "_web_app_deployer_policy" {
  name = "_web_app_deployer_policy"
  user = "${aws_iam_user._web_app_deployer.name}"

  policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecs:UpdateService"
      ],
      "Effect": "Allow",
      "Resource": "*"
    }
  ]
}
EOF
}

resource "aws_iam_access_key" "_web_app_deployer_access_key" {
  user = "${aws_iam_user._web_app_deployer.name}"
}