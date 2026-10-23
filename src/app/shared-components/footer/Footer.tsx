"use client";
import {
  Box,
  Container,
  Link,
  Typography,
  Divider,
  Accordion,
  AccordionSummary,
  AccordionDetails,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { forwardRef } from "react";
import "./Footer.css"; // Import your CSS file for media queries

// Define the type for FooterLink props
interface FooterLinkProps {
  href: string;
  title: string;
}

// Define the type for FooterColumn props
interface FooterColumnProps {
  columnGroups: {
    title: string;
    items: string[];
  }[];
}

const FooterLink = ({ href, title }: FooterLinkProps) => (
  <Link
    href={href}
    variant="body2"
    color="text.secondary"
    underline="hover"
    sx={{ display: "block", mb: 0.5 }}
  >
    {title}
  </Link>
);

const FooterColumn = ({ columnGroups }: FooterColumnProps) => {
  return (
    <>
      {/* For mobile view */}
      <Box className="mobile-only" sx={{ width: "100%" }}>
        {columnGroups.map((group, index) => (
          <Accordion key={index}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography variant="subtitle1">{group.title}</Typography>
            </AccordionSummary>
            <AccordionDetails>
              {group.items.map((item, itemIndex) => (
                <FooterLink key={itemIndex} href="#" title={item} />
              ))}
            </AccordionDetails>
          </Accordion>
        ))}
      </Box>

      {/* For desktop view */}
      <Box
        className="desktop-only"
        sx={{
          flex: "1",
          minWidth: 0,
          maxWidth: "100%",
          padding: "0 16px",
        }}
      >
        {columnGroups.map((group, index) => (
          <Box key={index} sx={{ mb: 3 }}>
            <Typography variant="subtitle1" gutterBottom>
              {group.title}
            </Typography>
            {group.items.map((item, itemIndex) => (
              <FooterLink key={itemIndex} href="#" title={item} />
            ))}
          </Box>
        ))}
      </Box>
    </>
  );
};

const Footer = forwardRef<HTMLDivElement>((_, ref) => {
  const footerColumns = [
    // add as required
    {
      columnGroups: [
        // {
        //   title: "Programmes",
        //   items: ["daSH", "dancED"],
        // },
      ],
    },
    // {
    //   columnGroups: [
    //     {
    //       title: "Classes",
    //       items: [
    //         "Mat Pilates",
    //         "Fun-size movers",
    //         "Creative Contemporary Dance",
    //         "daSH residency",
    //       ],
    //     },
    //   ],
    // },
  ];

  return (
    <Box
      component="footer"
      ref={ref}
      id="footer"
      sx={{ backgroundColor: "#e8e8ea", py: 4 }}
    >
      <Container maxWidth="lg">
        {/* <Divider sx={{ my: 4 }} /> */}
        <Box
          sx={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "space-between",
            rowGap: 2,
          }}
        >
          {footerColumns.map((column, index) => (
            <FooterColumn key={index} columnGroups={column.columnGroups} />
          ))}
        </Box>
        <Box sx={{ mt: 2, mb: 1 }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
            22, #08-087 Midview City, Singapore 573969
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
            Phone:{" "}
            <Link href="tel:+6592954911" color="inherit" underline="hover">
              +65 9295 4911
            </Link>
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Need to contact us?{" "}
            <Link
              href="mailto:mxyychua@mxyyc.community"
              color="inherit"
              underline="hover"
            >
              Click here to Email us!
            </Link>
          </Typography>
        </Box>
        <Divider sx={{ my: 1 }} />
        <Box
          display="flex"
          justifyContent="left"
          alignItems="center"
          flexWrap="wrap"
        >
          <Typography variant="body2" color="text.secondary" align="left">
            Copyright © 2026 MXYYC. All rights reserved.
          </Typography>
          <Box sx={{ mx: { xs: 1, sm: 2 } }}>|</Box>
          <Link
            href="/about-us"
            color="inherit"
            underline="hover"
            fontSize={{ xs: 10, md: 15 }}
          >
            About Us
          </Link>
          <Box sx={{ mx: { xs: 1, sm: 2 } }}>|</Box>
          <Link
            href="/contact-us"
            color="inherit"
            underline="hover"
            fontSize={{ xs: 10, md: 15 }}
          >
            Contact Us
          </Link>
          <Box sx={{ mx: { xs: 1, sm: 2 } }}>|</Box>
          <Link
            href="/terms"
            color="inherit"
            underline="hover"
            fontSize={{ xs: 10, md: 15 }}
          >
            Terms of Service
          </Link>
          <Box sx={{ mx: { xs: 1, sm: 2 } }}>|</Box>
          <Link
            href="/privacy"
            color="inherit"
            underline="hover"
            fontSize={{ xs: 10, md: 15 }}
          >
            Privacy Policy
          </Link>
          <Box sx={{ mx: { xs: 1, sm: 2 } }}>|</Box>
          <Link
            href="/refund-policy"
            color="inherit"
            underline="hover"
            fontSize={{ xs: 10, md: 15 }}
          >
            Refund Policy
          </Link>
          <Box sx={{ mx: { xs: 1, sm: 2 } }}>|</Box>
        </Box>
      </Container>
    </Box>
  );
});

Footer.displayName = "Footer";

export default Footer;
