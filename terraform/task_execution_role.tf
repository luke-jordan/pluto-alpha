resource "aws_iam_role" "task_execution" {
  name = "task_execution"
  assume_role_policy = <<EOF
{
  "Version": "2008-10-17",
  "Statement": [
    {
      "Action": "sts:AssumeRole",
      "Principal": {
        "Service": ["ecs-tasks.amazonaws.com"]
      },
      "Effect": "Allow"
    }
  ]
}
EOF
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role = "${aws_iam_role.task_execution.name}"
  policy_arn = "${aws_iam_policy.task_execution.arn}"
}

resource "aws_iam_policy" "task_execution" {
  name = "task_execution"

  policy = <<EOF
{
"Version": "2012-10-17",
"Statement": [
  {
    "Action": [
      "ecr:GetAuthorizationToken",
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
      "logs:CreateLogStream",
      "logs:PutLogEvents"
    ],
    "Effect": "Allow",
    "Resource": "*"
  }
]
}
EOF

}
