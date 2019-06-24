resource "aws_security_group" "sg_5432_egress" {
  name = "${terraform.workspace}-5432-egress"

  vpc_id = "${aws_vpc.main.id}"

   egress {
      from_port  = 5432
      to_port = 5432
      protocol = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }

}

resource "aws_security_group" "sg_433_egress" {
  name = "${terraform.workspace}-433-egress"

  vpc_id = "${aws_vpc.main.id}"

   egress {
      from_port  = 433
      to_port = 433
      protocol = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }

}

resource "aws_security_group" "sg_db_5432_ingress" {
  name = "${terraform.workspace}-rds-sg"

  vpc_id = "${aws_vpc.main.id}"

  // allows traffic from the SG itself
  ingress {
      from_port = 0
      to_port = 0
      protocol = "-1"
      self = true
  }

  //allow traffic for TCP 5432
  ingress {
      from_port = 5432
      to_port   = 5432
      protocol  = "tcp"
      security_groups = ["${aws_security_group.sg_db_access_sg.id}"]
  }

  // outbound internet access
  egress {
    from_port = 0
    to_port = 0
    protocol = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

/* Security Group for resources that want to access the Database */
resource "aws_security_group" "sg_db_access_sg" {
  vpc_id      = "${aws_vpc.main.id}"
  name        = "${terraform.workspace}-db-access-sg"
  description = "Allow access to RDS"
}