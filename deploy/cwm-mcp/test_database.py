#!/usr/bin/env python3
"""
Test Database Connection

This script checks if the database exists and can be connected to properly.
It also displays some basic statistics about the database content.

Usage:
    python test_database.py
"""

import os
import sqlite3
import sys

def test_database():
    """Test the database connection and display basic statistics."""
    # Path to the database file
    db_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "api_gateway", "connectwise_api.db")
    
    # Check if the database file exists
    if not os.path.exists(db_path):
        print(f"Error: Database file not found at {db_path}")
        print("Please run build_database.py first to generate the database.")
        return False
    
    try:
        # Connect to the database
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        # Get endpoint count
        cursor.execute("SELECT COUNT(*) FROM endpoints")
        endpoint_count = cursor.fetchone()[0]
        
        # Get parameter count
        cursor.execute("SELECT COUNT(*) FROM parameters")
        parameter_count = cursor.fetchone()[0]
        
        # Get category count
        cursor.execute("SELECT COUNT(DISTINCT category) FROM endpoints")
        category_count = cursor.fetchone()[0]
        
        # Get top 5 categories
        cursor.execute("""
            SELECT category, COUNT(*) as count 
            FROM endpoints 
            GROUP BY category 
            ORDER BY count DESC
            LIMIT 5
        """)
        top_categories = cursor.fetchall()
        
        # Display database statistics
        print("\n======= Database Statistics =======")
        print(f"Database location: {db_path}")
        print(f"Total API endpoints: {endpoint_count}")
        print(f"Total parameters: {parameter_count}")
        print(f"Total categories: {category_count}")
        
        print("\nTop 5 categories by endpoint count:")
        for category, count in top_categories:
            print(f"  - {category}: {count} endpoints")
        
        # Test a simple query
        print("\nTesting sample query...")
        cursor.execute("""
            SELECT path, method, description 
            FROM endpoints 
            WHERE path LIKE '%ticket%' 
            LIMIT 3
        """)
        sample_tickets = cursor.fetchall()
        
        if sample_tickets:
            print("Sample ticket endpoints:")
            for path, method, description in sample_tickets:
                print(f"  - {method.upper()} {path}")
                print(f"    {description}")
        else:
            print("No ticket endpoints found in the database. This is unusual.")
        
        # Close the connection
        conn.close()
        
        print("\nDatabase test completed successfully!")
        return True
        
    except sqlite3.Error as e:
        print(f"Error connecting to database: {e}")
        return False

if __name__ == "__main__":
    success = test_database()
    if not success:
        sys.exit(1)
